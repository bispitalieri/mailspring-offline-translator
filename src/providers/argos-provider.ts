/**
 * Argos model provider backed by the native CTranslate2 Node.js binding.
 */

import type AdmZip from 'adm-zip';
import type { Ct2Translator } from 'ctranslate2';
import { ITranslationProvider } from './provider-interface';
import {
  LanguageDetectionResult,
  LanguagePair,
  ModelPackage,
  ProviderInfo,
  TranslationRequest,
  TranslationResult,
} from '../types';
import { normalizeLanguageTag } from '../bcp47';
import { ProcessManager } from '../process-manager';

const MODEL_CATALOG_URL = 'https://raw.githubusercontent.com/argosopentech/argospm-index/master/index.json';
const MODEL_METADATA_FILE = '.mailspring-model.json';

interface ArgosCatalogEntry {
  from_code: string;
  from_name: string;
  to_code: string;
  to_name: string;
  package_version: string;
  package_size?: number;
  links: string[];
}

interface InstalledModel extends ModelPackage {
  modelPath: string;
}

interface CTranslate2Runtime {
  Ct2Translator: typeof Ct2Translator;
}

interface LanguageDetector {
  detect(text: string, limit: number): Array<[string, number]>;
  setLanguageType(type: 'iso2'): void;
}

export class ArgosTranslationProvider implements ITranslationProvider {
  private readonly modelsDirectory: string;
  private readonly translators = new Map<string, InstanceType<typeof Ct2Translator>>();
  private languageDetector: LanguageDetector | null = null;
  private availabilityError: string | null = null;
  private isAvailableCache: boolean | null = null;

  constructor(customBaseDir?: string) {
    if (customBaseDir) {
      const path = this.getNodeModule<typeof import('path')>('path');
      this.modelsDirectory = path.join(customBaseDir, 'data', 'models');
    } else {
      this.modelsDirectory = ProcessManager.getModelsDirectory();
    }
  }

  public getInfo(): ProviderInfo {
    return {
      id: 'argos',
      name: 'Argos Translate (CTranslate2)',
      version: '1.0.0',
      platform: ['darwin', 'win32', 'linux'],
      description: this.isAvailableCache
        ? 'CTranslate2 native inference is ready. Installed models run offline.'
        : 'Native CTranslate2 inference with offline Argos language models.',
      requiresNPU: false,
      isAvailable: this.isAvailableCache === true,
      unavailabilityReason: this.isAvailableCache
        ? undefined
        : this.availabilityError ?? 'Download an Argos model and ensure the native CTranslate2 runtime is supported.',
      isStandaloneRuntime: true,
    };
  }

  public async isAvailable(): Promise<boolean> {
    try {
      this.getRuntime();
      this.isAvailableCache = (await this.getInstalledModels()).length > 0;
      this.availabilityError = this.isAvailableCache
        ? null
        : 'No Argos models are installed. Download a model from Offline Models in Preferences.';
    } catch (error) {
      this.isAvailableCache = false;
      this.availabilityError = `CTranslate2 is unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }

    return this.isAvailableCache;
  }

  public async getSupportedLanguages(): Promise<LanguagePair[]> {
    return (await this.getInstalledModels()).map((model) => ({
      source: model.fromCode,
      target: model.toCode,
      sourceName: model.fromName,
      targetName: model.toName,
      installed: true,
      modelSizeMB: model.sizeMB,
      providerId: 'argos',
    }));
  }

  public async listInstallableModels(): Promise<ModelPackage[]> {
    const response = await fetch(MODEL_CATALOG_URL);
    if (!response.ok) {
      throw new Error(`Could not fetch the Argos model catalog (HTTP ${response.status}).`);
    }

    const entries = await response.json() as ArgosCatalogEntry[];
    if (!Array.isArray(entries)) {
      throw new Error('Argos returned an invalid model catalog.');
    }

    const installed = new Set(
      (await this.getInstalledModels()).map((model) => `${model.fromCode}->${model.toCode}`)
    );

    return entries
      .filter((entry) => this.isCatalogEntry(entry))
      .map((entry) => ({
        fromCode: normalizeLanguageTag(entry.from_code),
        fromName: entry.from_name,
        toCode: normalizeLanguageTag(entry.to_code),
        toName: entry.to_name,
        packageVersion: entry.package_version,
        sizeMB: Number(entry.package_size) > 0
          ? Number((Number(entry.package_size) / (1024 * 1024)).toFixed(1))
          : 0,
        isInstalled: installed.has(
          `${normalizeLanguageTag(entry.from_code)}->${normalizeLanguageTag(entry.to_code)}`
        ),
        downloadUrl: entry.links.find((url) => typeof url === 'string' && url.startsWith('https://')),
        provider: 'argos' as const,
      }));
  }

  public async installModel(
    fromLang: string,
    toLang: string,
    onProgress?: (percent: number, message: string) => void
  ): Promise<boolean> {
    const fs = this.getNodeModule<typeof import('fs')>('fs');
    const path = this.getNodeModule<typeof import('path')>('path');
    const source = normalizeLanguageTag(fromLang);
    const target = normalizeLanguageTag(toLang);
    const catalog = await this.listInstallableModels();
    const model = catalog.find((entry) => entry.fromCode === source && entry.toCode === target);
    if (!model?.downloadUrl) {
      throw new Error(`No downloadable Argos model is available for ${source} -> ${target}.`);
    }

    await fs.promises.mkdir(this.modelsDirectory, { recursive: true });
    const key = this.modelKey(source, target);
    const destination = path.join(this.modelsDirectory, key);
    const staging = path.join(this.modelsDirectory, `.${key}-${process.pid}-${Date.now()}.tmp`);
    const backup = `${destination}.backup-${process.pid}`;
    const archivePath = path.join(this.modelsDirectory, `.${key}-${process.pid}.argosmodel`);

    try {
      onProgress?.(0, 'Downloading Argos model...');
      await this.downloadModel(model.downloadUrl, archivePath, model.sizeMB, onProgress);
      onProgress?.(92, 'Extracting and validating the model...');

      await fs.promises.mkdir(staging, { recursive: true });
      this.extractArchive(archivePath, staging);
      const extractedModelPath = await this.findCTranslate2Model(staging);
      if (!extractedModelPath) {
        throw new Error('The downloaded Argos archive does not contain a CTranslate2 model and shared vocabulary.');
      }
      await this.prepareCTranslate2Model(staging, extractedModelPath);

      const metadata: InstalledModel = {
        ...model,
        fromCode: source,
        toCode: target,
        isInstalled: true,
        modelPath: path.relative(staging, extractedModelPath),
      };
      await fs.promises.writeFile(
        path.join(staging, MODEL_METADATA_FILE),
        JSON.stringify(metadata, null, 2),
        'utf8'
      );

      let hadPreviousInstall = false;
      try {
        await fs.promises.rename(destination, backup);
        hadPreviousInstall = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }

      try {
        await fs.promises.rename(staging, destination);
      } catch (error) {
        if (hadPreviousInstall) await fs.promises.rename(backup, destination);
        throw error;
      }

      if (hadPreviousInstall) await fs.promises.rm(backup, { recursive: true, force: true });
      this.translators.delete(`${source}->${target}`);
      this.isAvailableCache = null;
      this.availabilityError = null;
      onProgress?.(100, 'Model installed and ready for offline translation.');
      return true;
    } finally {
      await fs.promises.rm(staging, { recursive: true, force: true });
      await fs.promises.rm(archivePath, { force: true });
    }
  }

  public async removeModel(fromLang: string, toLang: string): Promise<boolean> {
    const fs = this.getNodeModule<typeof import('fs')>('fs');
    const path = this.getNodeModule<typeof import('path')>('path');
    const source = normalizeLanguageTag(fromLang);
    const target = normalizeLanguageTag(toLang);
    const destination = path.join(this.modelsDirectory, this.modelKey(source, target));
    const installed = (await this.getInstalledModels()).some(
      (model) => model.fromCode === source && model.toCode === target
    );
    if (!installed) return false;

    await fs.promises.rm(destination, { recursive: true, force: true });
    this.translators.delete(`${source}->${target}`);
    this.isAvailableCache = null;
    this.availabilityError = null;
    return true;
  }

  public async detectLanguage(text: string): Promise<LanguageDetectionResult> {
    if (!text.trim()) return { language: 'en', confidence: 1, isReliable: true };

    try {
      if (!this.languageDetector) {
        const LanguageDetect = this.getNodeModule<new () => LanguageDetector>('languagedetect');
        this.languageDetector = new LanguageDetect();
        this.languageDetector.setLanguageType('iso2');
      }
      const [language, confidence] = this.languageDetector.detect(text, 1)[0] ?? [];
      if (typeof language !== 'string' || typeof confidence !== 'number') {
        return { language: 'en', confidence: 0.5, isReliable: false };
      }
      return {
        language: normalizeLanguageTag(language),
        confidence,
        isReliable: confidence >= 0.35,
      };
    } catch {
      return { language: 'en', confidence: 0.5, isReliable: false };
    }
  }

  public async canTranslate(sourceLang: string, targetLang: string): Promise<boolean> {
    const source = normalizeLanguageTag(sourceLang);
    const target = normalizeLanguageTag(targetLang);
    if (source === target) return true;

    return (await this.getInstalledModels()).some(
      (model) => model.fromCode === source && model.toCode === target
    );
  }

  public async translate(request: TranslationRequest): Promise<TranslationResult> {
    const start = Date.now();
    const source = request.sourceLang === 'auto'
      ? (await this.detectLanguage(request.text)).language
      : normalizeLanguageTag(request.sourceLang);
    const target = normalizeLanguageTag(request.targetLang);
    const installed = (await this.getInstalledModels()).find(
      (model) => model.fromCode === source && model.toCode === target
    );
    if (!installed) {
      throw new Error(`No installed Argos model for ${source} -> ${target}.`);
    }

    const key = `${source}->${target}`;
    let translator = this.translators.get(key);
    if (!translator) {
      const Runtime = this.getRuntime().Ct2Translator;
      translator = new Runtime({ modelPath: installed.modelPath, device: 'cpu' });
      this.translators.set(key, translator);
    }

    const results = await translator.translateBatch([request.text]);
    if (!results[0]?.text) {
      throw new Error(`CTranslate2 returned no translation for ${source} -> ${target}.`);
    }

    return {
      id: request.id,
      translatedText: results[0].text,
      detectedSourceLang: source,
      targetLang: target,
      providerUsed: 'argos',
      providerName: 'Argos Translate (CTranslate2)',
      fromCache: false,
      durationMs: Date.now() - start,
    };
  }

  public cancel(_requestId: string): void {}

  public dispose(): void {
    this.translators.clear();
    this.languageDetector = null;
    this.isAvailableCache = null;
    this.availabilityError = null;
  }

  private getRuntime(): CTranslate2Runtime {
    return this.getNodeModule<CTranslate2Runtime>('ctranslate2');
  }

  private async getInstalledModels(): Promise<InstalledModel[]> {
    const fs = this.getNodeModule<typeof import('fs')>('fs');
    const path = this.getNodeModule<typeof import('path')>('path');
    let entries: import('fs').Dirent[];
    try {
      entries = await fs.promises.readdir(this.modelsDirectory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw error;
    }

    const models: InstalledModel[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      const modelDirectory = path.join(this.modelsDirectory, entry.name);
      try {
        const metadata = JSON.parse(
          await fs.promises.readFile(path.join(modelDirectory, MODEL_METADATA_FILE), 'utf8')
        ) as InstalledModel;
        const modelPath = path.resolve(modelDirectory, metadata.modelPath);
        if (!modelPath.startsWith(`${path.resolve(modelDirectory)}${path.sep}`) &&
            modelPath !== path.resolve(modelDirectory)) {
          continue;
        }
        await fs.promises.access(path.join(modelPath, 'model.bin'));
        await fs.promises.access(path.join(modelPath, 'config.json'));
        await fs.promises.access(path.join(modelPath, 'source.spm'));
        await fs.promises.access(path.join(modelPath, 'target.spm'));
        await fs.promises.access(path.join(modelPath, 'shared_vocabulary.txt'));
        models.push({ ...metadata, modelPath });
      } catch {
        continue;
      }
    }
    return models;
  }

  private async downloadModel(
    url: string,
    destination: string,
    expectedSizeMB: number,
    onProgress?: (percent: number, message: string) => void
  ): Promise<void> {
    const fs = this.getNodeModule<typeof import('fs')>('fs');
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:') {
      throw new Error('Argos model downloads must use HTTPS.');
    }

    const response = await fetch(parsedUrl);
    if (!response.ok || !response.body) {
      throw new Error(`Argos model download failed (HTTP ${response.status}).`);
    }
    if (!response.url.startsWith('https://')) {
      throw new Error('Argos model download redirected to a non-HTTPS URL.');
    }

    const reader = response.body.getReader();
    const file = await fs.promises.open(destination, 'w');
    let downloaded = 0;
    const total = Number(response.headers.get('content-length')) || expectedSizeMB * 1024 * 1024;
    let lastReported = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await file.writeFile(value);
        downloaded += value.byteLength;
        const now = Date.now();
        if (now - lastReported >= 500) {
          const percent = total > 0 ? Math.min(90, Math.round(downloaded / total * 90)) : 45;
          onProgress?.(percent, `Downloading model (${(downloaded / 1048576).toFixed(1)} MB)`);
          lastReported = now;
        }
      }
    } catch (error) {
      await reader.cancel();
      throw error;
    } finally {
      await file.close();
    }
  }

  private extractArchive(archivePath: string, destination: string): void {
    const path = this.getNodeModule<typeof import('path')>('path');
    const AdmZipConstructor = this.getNodeModule<typeof AdmZip>('adm-zip');
    const archive = new AdmZipConstructor(archivePath);
    const destinationPath = path.resolve(destination);
    for (const entry of archive.getEntries()) {
      const normalizedName = entry.entryName.replace(/\\/g, '/');
      const target = path.resolve(destinationPath, normalizedName);
      if (
        path.isAbsolute(normalizedName) ||
        normalizedName.split('/').includes('..') ||
        (target !== destinationPath && !target.startsWith(`${destinationPath}${path.sep}`))
      ) {
        throw new Error(`The Argos archive contains an unsafe path: ${entry.entryName}`);
      }
      const fileType = (entry.header.attr >>> 28) & 0xf;
      if (fileType === 0xa) {
        throw new Error(`The Argos archive contains an unsupported symbolic link: ${entry.entryName}`);
      }
      archive.extractEntryTo(entry, destinationPath, true, true);
    }
  }

  private async findCTranslate2Model(root: string): Promise<string | null> {
    const fs = this.getNodeModule<typeof import('fs')>('fs');
    const path = this.getNodeModule<typeof import('path')>('path');
    const pending = [root];
    while (pending.length > 0) {
      const current = pending.pop()!;
      const entries = await fs.promises.readdir(current, { withFileTypes: true });
      if (
        entries.some((entry) => entry.isFile() && entry.name === 'model.bin') &&
        entries.some((entry) => entry.isFile() && entry.name === 'shared_vocabulary.txt')
      ) {
        return current;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) pending.push(path.join(current, entry.name));
      }
    }
    return null;
  }

  private async prepareCTranslate2Model(root: string, modelPath: string): Promise<void> {
    const fs = this.getNodeModule<typeof import('fs')>('fs');
    const path = this.getNodeModule<typeof import('path')>('path');
    const sentencePiecePath = await this.findFile(root, 'sentencepiece.model');
    const sourcePath = path.join(modelPath, 'source.spm');
    const targetPath = path.join(modelPath, 'target.spm');

    if (sentencePiecePath) {
      if (!(await this.fileExists(sourcePath))) await fs.promises.copyFile(sentencePiecePath, sourcePath);
      if (!(await this.fileExists(targetPath))) await fs.promises.copyFile(sentencePiecePath, targetPath);
    }

    if (!(await this.fileExists(sourcePath)) || !(await this.fileExists(targetPath))) {
      throw new Error('The Argos archive does not include the SentencePiece tokenizer files required by CTranslate2.');
    }
    if (!(await this.fileExists(path.join(modelPath, 'config.json')))) {
      await fs.promises.writeFile(path.join(modelPath, 'config.json'), '{}', 'utf8');
    }
  }

  private async findFile(root: string, fileName: string): Promise<string | null> {
    const fs = this.getNodeModule<typeof import('fs')>('fs');
    const path = this.getNodeModule<typeof import('path')>('path');
    const pending = [root];
    while (pending.length > 0) {
      const current = pending.pop()!;
      const entries = await fs.promises.readdir(current, { withFileTypes: true });
      if (entries.some((entry) => entry.isFile() && entry.name === fileName)) {
        return path.join(current, fileName);
      }
      for (const entry of entries) {
        if (entry.isDirectory()) pending.push(path.join(current, entry.name));
      }
    }
    return null;
  }

  private async fileExists(filePath: string): Promise<boolean> {
    const fs = this.getNodeModule<typeof import('fs')>('fs');
    try {
      await fs.promises.access(filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  private isCatalogEntry(entry: ArgosCatalogEntry): boolean {
    return Boolean(
      entry &&
      /^[a-z0-9-]+$/i.test(entry.from_code) &&
      /^[a-z0-9-]+$/i.test(entry.to_code) &&
      typeof entry.from_name === 'string' &&
      typeof entry.to_name === 'string' &&
      typeof entry.package_version === 'string' &&
      Array.isArray(entry.links)
    );
  }

  private modelKey(source: string, target: string): string {
    if (!/^[a-z0-9-]+$/i.test(source) || !/^[a-z0-9-]+$/i.test(target)) {
      throw new Error('Invalid language code in Argos model request.');
    }
    return `${source}-${target}`;
  }

  private getNodeModule<T>(moduleName: string): T {
    const loader = typeof require !== 'undefined'
      ? require
      : (globalThis as any).require;
    if (typeof loader !== 'function') {
      throw new Error(`Could not load the Node.js ${moduleName} module.`);
    }
    return loader(moduleName) as T;
  }
}
