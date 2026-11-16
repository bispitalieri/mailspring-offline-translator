/**
 * OPUS-MT model provider backed by the native CTranslate2 Node.js binding.
 * Downloads models from HuggingFace that are already converted to CTranslate2 format.
 */

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
import { normalizeLanguageTag } from '../utils/bcp47';
import { ProcessManager } from '../utils/process-manager';

const MODEL_METADATA_FILE = '.mailspring-model.json';

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

// Mappa dei modelli OPUS-MT disponibili su HuggingFace in formato CTranslate2
// Formato: "source-target" => { repo_id, revision, files, estimatedSizeMB }
interface OpusModelDefinition {
  repoId: string;
  files: string[];
  estimatedSizeMB?: number;
}

// I modelli OPUS-MT sono disponibili su HuggingFace da Sams200
// Questi repo contengono il file model.bin necessario per CTranslate2
// (i repo di gaudi non hanno model.bin, quindi non sono utilizzabili)
// La struttura dei file Sams200: model.bin, config.json, source.spm, target.spm, shared_vocabulary.json
function buildOpusCatalog(): Record<string, OpusModelDefinition> {
  const standardFiles = ['model.bin', 'config.json', 'source.spm', 'target.spm', 'shared_vocabulary.json'];
  const pairs: [string, string][] = [
    // Coppie principali bidirezionali
    ['en', 'it'], ['it', 'en'],
    ['en', 'es'], ['es', 'en'],
    ['en', 'fr'], ['fr', 'en'],
    ['en', 'de'], ['de', 'en'],
    ['en', 'ru'], ['ru', 'en'],
    ['en', 'zh'], ['zh', 'en'],
    ['en', 'ar'], ['ar', 'en'],
    ['en', 'nl'], ['nl', 'en'],
    ['en', 'sv'], ['sv', 'en'],
    ['en', 'da'], ['da', 'en'],
    ['en', 'fi'], ['fi', 'en'],
    ['en', 'cs'], ['cs', 'en'],
    ['en', 'hu'], ['hu', 'en'],
    ['en', 'ro'], ['ro', 'en'],
    ['en', 'bg'], ['bg', 'en'],
    ['en', 'sk'], ['sk', 'en'],
    ['en', 'id'], ['id', 'en'],
    ['en', 'uk'], ['uk', 'en'],
    ['en', 'ca'], ['ca', 'en'],
    ['en', 'vi'], ['vi', 'en'],
    ['en', 'gl'], ['gl', 'en'],
    ['en', 'mk'], ['mk', 'en'],
    ['en', 'sq'], ['sq', 'en'],
    ['en', 'et'], ['et', 'en'],
    ['en', 'af'], ['af', 'en'],
    ['en', 'az'], ['az', 'en'],
    ['en', 'bn'], ['bn', 'en'],
    ['en', 'ml'], ['ml', 'en'],
    ['en', 'mr'], ['mr', 'en'],
    ['en', 'ur'], ['ur', 'en'],
    ['en', 'mt'], ['mt', 'en'],
    ['en', 'tl'], ['tl', 'en'],
    ['en', 'hi'], ['hi', 'en'],
    ['en', 'eo'], ['eo', 'en'],
    ['en', 'eu'], ['eu', 'en'],
    ['en', 'ceb'], ['ceb', 'en'],
    ['en', 'ga'], ['ga', 'en'],
    ['en', 'ha'], ['ha', 'en'],
    ['en', 'mg'], ['mg', 'en'],
    ['en', 'fj'], ['fj', 'en'],
    ['en', 'lg'], ['lg', 'en'],
    ['en', 'ln'], ['ln', 'en'],
    ['en', 'sg'], ['sg', 'en'],
    ['en', 'sm'], ['sm', 'en'],
    ['en', 'sn'], ['sn', 'en'],
    ['en', 'rn'], ['rn', 'en'],
    ['en', 'ny'], ['ny', 'en'],
    ['en', 'pag'], ['pag', 'en'],
    ['en', 'ss'], ['ss', 'en'],
    ['en', 'tn'], ['tn', 'en'],
    ['en', 'tpi'], ['tpi', 'en'],
    ['en', 'st'], ['st', 'en'],
    ['en', 'ig'], ['ig', 'en'],
    ['en', 'ee'], ['ee', 'en'],
    ['en', 'ht'], ['ht', 'en'],
    // Solo en → X (inglese verso altre lingue)
    ['en', 'el'],
    ['en', 'he'],
    ['en', 'hy'],
    ['en', 'ilo'],
    ['en', 'is'],
    ['en', 'it'],
    ['en', 'sw'],
    ['en', 'ti'],
    ['en', 'tw'],
    ['en', 'xh'],
    ['en', 'pap'],
    // Solo X → en (altre lingue verso inglese)
    ['ja', 'en'],
    ['ko', 'en'],
    ['th', 'en'],
    ['tr', 'en'],
    ['pl', 'en'],
    ['ka', 'en'],
    ['pa', 'en'],
    ['cy', 'en'],
    ['is', 'en'],
    ['lv', 'en'],
    ['war', 'en'],
    ['yo', 'en'],
    ['xh', 'en'],
    ['ceb', 'en'],
    ['eo', 'en'],
    ['fj', 'en'],
    ['ha', 'en'],
    ['lg', 'en'],
    ['ln', 'en'],
    ['pap', 'en'],
    ['ti', 'en'],
    ['ts', 'en'],
  ];

  const catalog: Record<string, OpusModelDefinition> = {};
  for (const [src, tgt] of pairs) {
    const key = `${src}-${tgt}`;
    catalog[key] = {
      repoId: `Sams200/opus-mt-${src}-${tgt}`,
      files: standardFiles,
      estimatedSizeMB: 0,
    };
  }
  return catalog;
}

const OPUS_MODELS_CATALOG = buildOpusCatalog();

// Nomi dei linguaggi per il catalogo
const LANGUAGE_NAMES: Record<string, string> = {
  'en': 'English',
  'it': 'Italian',
  'es': 'Spanish',
  'fr': 'French',
  'de': 'German',
  'pt': 'Portuguese',
  'ru': 'Russian',
  'zh': 'Chinese',
  'ja': 'Japanese',
  'ko': 'Korean',
  'ar': 'Arabic',
  'tr': 'Turkish',
  'pl': 'Polish',
  'nl': 'Dutch',
  'sv': 'Swedish',
  'da': 'Danish',
  'fi': 'Finnish',
  'cs': 'Czech',
  'hu': 'Hungarian',
  'ro': 'Romanian',
  'bg': 'Bulgarian',
  'sk': 'Slovak',
  'id': 'Indonesian',
  'uk': 'Ukrainian',
  'ca': 'Catalan',
  'el': 'Greek',
  'he': 'Hebrew',
  'th': 'Thai',
  'vi': 'Vietnamese',
  'gl': 'Galician',
  'sl': 'Slovenian',
  'sr': 'Serbian',
  'hr': 'Croatian',
  'bs': 'Bosnian',
  'mk': 'Macedonian',
  'sq': 'Albanian',
  'lt': 'Lithuanian',
  'lv': 'Latvian',
  'et': 'Estonian',
  'af': 'Afrikaans',
  'sw': 'Swahili',
  'ms': 'Malay',
  'my': 'Burmese',
  'ka': 'Georgian',
  'ky': 'Kyrgyz',
  'uz': 'Uzbek',
  'az': 'Azerbaijani',
  'hy': 'Armenian',
  'am': 'Amharic',
  'ne': 'Nepali',
  'bn': 'Bengali',
  'ta': 'Tamil',
  'te': 'Telugu',
  'ml': 'Malayalam',
  'km': 'Khmer',
  'lo': 'Lao',
  'gu': 'Gujarati',
  'pa': 'Punjabi',
  'mr': 'Marathi',
  'or': 'Odia',
  'as': 'Assamese',
  'ur': 'Urdu',
  'fa': 'Persian',
  'ku': 'Kurdish',
  'ps': 'Pashto',
  'ckb': 'Sorani Kurdish',
  'tg': 'Tajik',
  'ber': 'Berber',
  'tyv': 'Tuvan',
  'ug': 'Uyghur',
  'tl': 'Tagalog',
  'hmn': 'Hmong',
  'mn': 'Mongolian',
  'bo': 'Tibetan',
};

export class OpusTranslationProvider implements ITranslationProvider {
  private readonly modelsDirectory: string;
  private readonly translators = new Map<string, InstanceType<typeof Ct2Translator>>();
  private languageDetector: LanguageDetector | null = null;
  private availabilityError: string | null = null;
  private isAvailableCache: boolean | null = null;

  constructor(customBaseDir?: string) {
    if (customBaseDir) {
      const path = this.getNodeModule<typeof import('path')>('path');
      this.modelsDirectory = path.join(customBaseDir, 'data', 'models', 'opus');
    } else {
      const path = this.getNodeModule<typeof import('path')>('path');
      this.modelsDirectory = path.join(ProcessManager.getModelsDirectory(), 'opus');
    }
  }

  public getInfo(): ProviderInfo {
    return {
      id: 'opus',
      name: 'OPUS-MT (CTranslate2)',
      version: '1.0.0',
      platform: ['darwin', 'win32', 'linux'],
      description: this.isAvailableCache
        ? 'CTranslate2 native inference is ready. Installed OPUS-MT models run offline.'
        : 'Native CTranslate2 inference with offline OPUS-MT language models from HuggingFace.',
      requiresNPU: false,
      isAvailable: this.isAvailableCache === true,
      unavailabilityReason: this.isAvailableCache
        ? undefined
        : this.availabilityError ?? 'Download an OPUS-MT model and ensure the native CTranslate2 runtime is supported.',
      isStandaloneRuntime: true,
    };
  }

  public async isAvailable(): Promise<boolean> {
    try {
      this.getRuntime();
      this.isAvailableCache = (await this.getInstalledModels()).length > 0;
      this.availabilityError = this.isAvailableCache
        ? null
        : 'No OPUS-MT models are installed. Download a model from Offline Models in Preferences.';
    } catch (error) {
      this.isAvailableCache = false;
      this.availabilityError = `CTranslate2 is unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }

    return this.isAvailableCache;
  }

  public async getSupportedLanguages(): Promise<LanguagePair[]> {
    const installedModels = await this.getInstalledModels();
    return installedModels.map((model) => ({
      source: model.fromCode,
      target: model.toCode,
      sourceName: model.fromName,
      targetName: model.toName,
      installed: true,
      modelSizeMB: model.sizeMB,
      providerId: 'opus',
    }));
  }

  public async listInstallableModels(): Promise<ModelPackage[]> {
    const installedModels = await this.getInstalledModels();
    const installedKeys = new Set(
      installedModels.map((model) => `${model.fromCode}->${model.toCode}`)
    );
    const installedSizeMap = new Map(
      installedModels.map((model) => [`${model.fromCode}->${model.toCode}`, model.sizeMB])
    );

    const models: ModelPackage[] = [];
    for (const [key, definition] of Object.entries(OPUS_MODELS_CATALOG)) {
      const [fromCode, toCode] = key.split('-');
      const fullKey = `${fromCode}->${toCode}`;
      const isInstalled = installedKeys.has(fullKey);
      const installedSize = installedSizeMap.get(fullKey);

      // Costruisce l'URL di download da HuggingFace
      const downloadUrl = `https://huggingface.co/${definition.repoId}/resolve/main/`;

      models.push({
        fromCode,
        fromName: LANGUAGE_NAMES[fromCode] || fromCode,
        toCode,
        toName: LANGUAGE_NAMES[toCode] || toCode,
        packageVersion: '1.0',
        sizeMB: isInstalled && installedSize !== undefined && installedSize > 0
          ? installedSize
          : (definition.estimatedSizeMB || 0),
        isInstalled,
        downloadUrl,
        provider: 'opus',
      });
    }

    return models;
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
    const key = `${source}-${target}`;
    const definition = OPUS_MODELS_CATALOG[key];

    if (!definition) {
      throw new Error(`No OPUS-MT model is available for ${source} -> ${target}.`);
    }

    await fs.promises.mkdir(this.modelsDirectory, { recursive: true });
    const destination = path.join(this.modelsDirectory, key);
    const staging = path.join(this.modelsDirectory, `.${key}-${process.pid}-${Date.now()}.tmp`);
    const backup = `${destination}.backup-${process.pid}`;

    try {
      onProgress?.(0, `Downloading OPUS-MT model for ${source} -> ${target}...`);
      await fs.promises.mkdir(staging, { recursive: true });

      // Scarica tutti i file del modello da HuggingFace
      const filesToDownload = definition.files;
      for (let i = 0; i < filesToDownload.length; i++) {
        const fileName = filesToDownload[i];
        const fileUrl = `https://huggingface.co/${definition.repoId}/resolve/main/${fileName}`;
        const filePath = path.join(staging, fileName);

        const fileProgress = 90 * (i / filesToDownload.length);
        onProgress?.(fileProgress, `Downloading ${fileName}...`);

        try {
          await this.downloadFile(fileUrl, filePath);
        } catch (error) {
          throw new Error(`Failed to download ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      onProgress?.(92, 'Validating the model...');

      // Verifica che tutti i file richiesti siano presenti
      for (const fileName of filesToDownload) {
        const filePath = path.join(staging, fileName);
        await fs.promises.access(filePath);
      }

      const metadata: InstalledModel = {
        fromCode: source,
        fromName: LANGUAGE_NAMES[source] || source,
        toCode: target,
        toName: LANGUAGE_NAMES[target] || target,
        packageVersion: '1.0',
        sizeMB: 0,
        isInstalled: true,
        modelPath: '.',
        provider: 'opus',
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
      onProgress?.(100, 'OPUS-MT model installed and ready for offline translation.');
      return true;
    } finally {
      await fs.promises.rm(staging, { recursive: true, force: true });
    }
  }

  public async removeModel(fromLang: string, toLang: string): Promise<boolean> {
    const fs = this.getNodeModule<typeof import('fs')>('fs');
    const path = this.getNodeModule<typeof import('path')>('path');
    const source = normalizeLanguageTag(fromLang);
    const target = normalizeLanguageTag(toLang);
    const destination = path.join(this.modelsDirectory, `${source}-${target}`);
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
      throw new Error(`No installed OPUS-MT model for ${source} -> ${target}.`);
    }

    const key = `${source}->${target}`;
    let translator = this.translators.get(key);
    if (!translator) {
      const Runtime = this.getRuntime().Ct2Translator;
      translator = new Runtime({ modelPath: installed.modelPath, device: 'cpu' });
      this.translators.set(key, translator);
    }

    // Estrai e preservi i placeholder prima della traduzione
    const { text: preparedText, placeholders } = this.extractPlaceholders(request.text);

    // Espandi le contrazioni inglesi per migliorare la traduzione
    let textToTranslate = preparedText;
    if (source === 'en') {
      textToTranslate = this.expandEnglishContractions(preparedText);
    }

    // Suddividi il testo in frasi per migliorare la qualità della traduzione
    const sentences = this.splitIntoSentences(textToTranslate);
    const translatedSentences: string[] = [];

    // Opzioni per prevenire il troncamento delle traduzioni
    const options = {
      maxInputLength: 512,
      maxDecodingLength: 512,
    };

    for (const sentence of sentences) {
      const results = await translator.translateBatch([sentence], options);
      if (!results[0]?.text) {
        throw new Error(`CTranslate2 returned no translation for ${source} -> ${target}.`);
      }
      translatedSentences.push(results[0].text);
    }

    let translatedText = translatedSentences.join('');
    translatedText = this.cleanTranslationArtifacts(translatedText);

    // Ripristina i placeholder estratti (URL, email, ecc.)
    translatedText = this.restorePlaceholders(translatedText, placeholders);

    return {
      id: request.id,
      translatedText,
      detectedSourceLang: source,
      targetLang: target,
      providerUsed: 'opus',
      providerName: 'OPUS-MT (CTranslate2)',
      fromCache: false,
      durationMs: Date.now() - start,
    };
  }

  // Suddivide il testo in frasi per migliorare la qualità della traduzione
  private splitIntoSentences(text: string): string[] {
    if (text.length <= 300) {
      return [text];
    }

    const sentences: string[] = [];
    const parts = text.split(/(?<=[.!?\n\r])/g);

    let buffer = '';
    for (const part of parts) {
      const candidate = buffer + part;
      if (candidate.length <= 350) {
        buffer = candidate;
      } else {
        if (buffer.trim()) {
          sentences.push(buffer);
        }
        buffer = part;
      }
    }

    if (buffer.trim()) {
      sentences.push(buffer);
    }

    if (sentences.length === 0) {
      const lines = text.split(/(\n+)/g);
      let lineBuffer = '';
      for (const chunk of lines) {
        if ((lineBuffer + chunk).length > 350 && lineBuffer.trim()) {
          sentences.push(lineBuffer);
          lineBuffer = chunk;
        } else {
          lineBuffer += chunk;
        }
      }
      if (lineBuffer.trim()) {
        sentences.push(lineBuffer);
      }
    }

    if (sentences.length === 0) {
      return [text];
    }

    return sentences;
  }

  // Rimuove artefatti noti prodotti dal modello
  private cleanTranslationArtifacts(text: string): string {
    text = text.replace(/\{\s*\\?displaystyle\s*\}/g, '');
    text = text.replace(/\{\s*[^}]*\\[a-z]+\s*\}/gi, '');
    text = text.replace(/,\s*anticipazione\s*\n/gi, ',\n');
    return text.trimEnd();
  }

  // Estrae i placeholder dal testo prima della traduzione per preservarli
  // Gestisce sia i placeholder HTML translator (con caratteri Unicode) che quelli generici
  private extractPlaceholders(text: string): { text: string; placeholders: Map<string, string> } {
    const placeholders = new Map<string, string>();
    let id = 0;

    // Placeholder HTML translator: \u200B\uFFFD(URL|EMAIL)_N\uFFFD\u200B
    text = text.replace(/\u200B\uFFFD(?:URL|EMAIL)_(\d+)\uFFFD\u200B/g, (_match, num) => {
      const placeholder = `__PLACEHOLDER_${id++}__`;
      placeholders.set(placeholder, _match);
      return placeholder;
    });

    // Placeholder generici {{URL_N}} e {{EMAIL_N}}
    text = text.replace(/\{\{(?:URL|EMAIL)_(\d+)\}\}/g, (_match) => {
      const placeholder = `__PLACEHOLDER_${id++}__`;
      placeholders.set(placeholder, _match);
      return placeholder;
    });

    // URL
    text = text.replace(/https?:\/\/[^\s<>"')\]]+/g, (match) => {
      const placeholder = `__PLACEHOLDER_${id++}__`;
      placeholders.set(placeholder, match);
      return placeholder;
    });

    // Email
    text = text.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, (match) => {
      const placeholder = `__PLACEHOLDER_${id++}__`;
      placeholders.set(placeholder, match);
      return placeholder;
    });

    return { text, placeholders };
  }

  // Ripristina i placeholder dopo la traduzione
  // Cerca sia il placeholder originale che le varianti che il modello potrebbe aver prodotto
  private restorePlaceholders(text: string, placeholders: Map<string, string>): string {
    for (const [placeholder, original] of placeholders.entries()) {
      // Cerca il placeholder originale
      text = text.replaceAll(placeholder, original);

      // Il modello potrebbe aver modificato il placeholder in vari modi:
      // - Aggiunto spazi: "__ PLACEHOLDER_0 __"
      // - Tradotto "PLACEHOLDER": "segnaposto_0", "marcador_0", etc.
      // - Modificato i trattini: "PLACEHOLDER-0", "PLACEHOLDER.0"
      const pattern = new RegExp(
        `\\s*__?\\s*[Pp]laceholder?[\\s_-]?${placeholder.match(/_(\d+)_/)?.[1] || '\\d+'}[\\s_.]?__?\\s*`,
        'gi'
      );
      text = text.replace(pattern, original);
    }
    return text;
  }

  // Espande le contrazioni inglesi comuni per migliorare la traduzione
  // I modelli OPUS-MT traducono meglio le forme complete
  private expandEnglishContractions(text: string): string {
    const contractions: [RegExp, string][] = [
      // Contrazioni con "be"
      [/\bi'm\b/gi, ' I am '],
      [/\byou're\b/gi, ' you are '],
      [/\bhe's\b/gi, ' he is '],
      [/\bshe's\b/gi, ' she is '],
      [/\bit's\b/gi, ' it is '],
      [/\bwe're\b/gi, ' we are '],
      [/\bthey're\b/gi, ' they are '],
      [/\bi've\b/gi, ' I have '],
      [/\byou've\b/gi, ' you have '],
      [/\bhe's\b/gi, ' he has '],
      [/\bshe's\b/gi, ' she has '],
      [/\bwe've\b/gi, ' we have '],
      [/\bthey've\b/gi, ' they have '],
      // Contrazioni con "will"
      [/\bi'll\b/gi, ' I will '],
      [/\byou'll\b/gi, ' you will '],
      [/\bhe'll\b/gi, ' he will '],
      [/\bshe'll\b/gi, ' she will '],
      [/\bit'll\b/gi, ' it will '],
      [/\bwe'll\b/gi, ' we will '],
      [/\bthey'll\b/gi, ' they will '],
      // Contrazioni con "would", "could", "should"
      [/\bi'd\b/gi, ' I would '],
      [/\byou'd\b/gi, ' you would '],
      [/\bhe'd\b/gi, ' he would '],
      [/\bshe'd\b/gi, ' she would '],
      [/\bwe'd\b/gi, ' we would '],
      [/\bthey'd\b/gi, ' they would '],
      [/\bi'd\b/gi, ' I should '],
      [/\byou'd\b/gi, ' you should '],
      // Contrazioni negative
      [/\bcan't\b/gi, ' cannot '],
      [/\bcannot\b/gi, ' cannot '],
      [/\bwon't\b/gi, ' will not '],
      [/\bshan't\b/gi, ' shall not '],
      [/\bdoesn't\b/gi, ' does not '],
      [/\bdon't\b/gi, ' do not '],
      [/\bdidn't\b/gi, ' did not '],
      [/\bisn't\b/gi, ' is not '],
      [/\baren't\b/gi, ' are not '],
      [/\bwasn't\b/gi, ' was not '],
      [/\bweren't\b/gi, ' were not '],
      [/\bhasn't\b/gi, ' has not '],
      [/\bhaven't\b/gi, ' have not '],
      [/\bhadn't\b/gi, ' had not '],
      [/\bwouldn't\b/gi, ' would not '],
      [/\bcouldn't\b/gi, ' could not '],
      [/\bshouldn't\b/gi, ' should not '],
      // Altre contrazioni comuni
      [/\blet's\b/gi, ' let us '],
      [/\bthat's\b/gi, ' that is '],
      [/\bwhat's\b/gi, ' what is '],
      [/\bwho's\b/gi, ' who is '],
      [/\bhere's\b/gi, ' here is '],
      [/\bthere's\b/gi, ' there is '],
      [/\bwhere's\b/gi, ' where is '],
      [/\bhow's\b/gi, ' how is '],
      [/\bthey'd\b/gi, ' they had '],
      [/\bthey'll\b/gi, ' they will '],
      // Contrazioni informali
      [/\bgonna\b/gi, ' going to '],
      [/\bwanna\b/gi, ' want to '],
      [/\bgotta\b/gi, ' got to '],
      [/\bkinda\b/gi, ' kind of '],
      [/\bsorta\b/gi, ' sort of '],
      [/\b kinda\b/gi, ' kind of '],
    ];

    let result = text;
    for (const [pattern, replacement] of contractions) {
      result = result.replace(pattern, replacement);
    }
    // Pulisci gli spazi doppi creati dalle sostituzioni
    result = result.replace(/\s{2,}/g, ' ').trim();
    return result;
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
        // Sams200 usa shared_vocabulary.json, alcuni repo usano shared_vocabulary.txt
        try {
          await fs.promises.access(path.join(modelPath, 'shared_vocabulary.json'));
        } catch {
          await fs.promises.access(path.join(modelPath, 'shared_vocabulary.txt'));
        }
        const actualSizeMB = await this.getDirectorySize(modelDirectory);
        models.push({ ...metadata, modelPath, sizeMB: actualSizeMB });
      } catch {
        continue;
      }
    }
    return models;
  }

  private async getDirectorySize(dirPath: string): Promise<number> {
    const fs = this.getNodeModule<typeof import('fs')>('fs');
    const path = this.getNodeModule<typeof import('path')>('path');
    let totalBytes = 0;
    const stack: string[] = [dirPath];
    while (stack.length > 0) {
      const current = stack.pop()!;
      let entries: import('fs').Dirent[];
      try {
        entries = await fs.promises.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else if (entry.isFile()) {
          try {
            const stat = await fs.promises.stat(fullPath);
            totalBytes += stat.size;
          } catch {
            // Ignora file non accessibili
          }
        }
      }
    }
    return Number((totalBytes / (1024 * 1024)).toFixed(1));
  }

  private async downloadFile(url: string, destination: string): Promise<void> {
    const fs = this.getNodeModule<typeof import('fs')>('fs');
    const parsedUrl = new URL(url);
    if (parsedUrl.protocol !== 'https:') {
      throw new Error('OPUS-MT model downloads must use HTTPS.');
    }

    const response = await fetch(parsedUrl);
    if (!response.ok || !response.body) {
      throw new Error(`OPUS-MT model download failed (HTTP ${response.status}).`);
    }
    if (!response.url.startsWith('https://')) {
      throw new Error('OPUS-MT model download redirected to a non-HTTPS URL.');
    }

    const reader = response.body.getReader();
    const file = await fs.promises.open(destination, 'w');
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await file.writeFile(value);
      }
    } catch (error) {
      await reader.cancel();
      throw error;
    } finally {
      await file.close();
    }
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
