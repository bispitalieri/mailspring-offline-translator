/**
 * Bergamot WASM Translation Provider
 *
 * Integrates the @browsermt/bergamot-translator WebAssembly engine with
 * Mozilla's Firefox Translations models (hosted on GitHub).
 *
 * Features:
 *  - On-demand model download from Mozilla's firefox-translations-models repository
 *  - Local model caching in the plugin's data/models/bergamot directory
 *  - HTML-aware translation via the native `html: true` option
 *  - Automatic memory release after inactivity timeout (keeps RAM < 300 MB)
 *  - Implements ITranslationProvider for seamless plugin integration
 */

import { ITranslationProvider } from './provider-interface';
import {
  LanguageDetectionResult,
  LanguagePair,
  ModelPackage,
  ProviderInfo,
  TranslationRequest,
  TranslationResult,
} from '../types';
import { ProcessManager, normalizeLanguageTag} from '../utils';

/** Language detection via languagedetect. */
interface LanguageDetector {
  detect(text: string, limit: number): Array<[string, number]>;
  setLanguageType(type: 'iso2'): void;
}

// ---------------------------------------------------------------------------
// Re-export types from the Bergamot package (ESM) so TypeScript can resolve
// them without a separate @types package.
// ---------------------------------------------------------------------------

/** Translation request passed to Bergamot's translate() method. */
interface BergamotRequest {
  from: string;
  to: string;
  text: string;
  html?: boolean;
  qualityScores?: boolean;
  priority?: number;
}

/** Translation response returned by Bergamot. */
interface BergamotResponse {
  request: BergamotRequest;
  target: { text: string };
}

/** Model registry entry – mirrors the shape returned by loadModelRegistery(). */
interface BergamotModelEntry {
  from: string;
  to: string;
  files: {
    [part: string]: {
      name: string;
      size?: number;
      expectedSha256Hash?: string;
    } | undefined;
  };
}

/** Buffers returned by loadTranslationModel() / getTranslationModel(). */
interface BergamotModelBuffers {
  model: ArrayBuffer;
  shortlist: ArrayBuffer | null;
  vocabs: ArrayBuffer[];
  qualityModel: ArrayBuffer | null;
  config?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Lazy-loaded Bergamot module (ESM dynamic import).
// ---------------------------------------------------------------------------

interface BergamotModule {
  BatchTranslator: new (opts?: Record<string, unknown>, backing?: any) => {
    translate(req: BergamotRequest): Promise<BergamotResponse>;
    delete(): Promise<void>;
  };
  LatencyOptimisedTranslator: new (opts?: Record<string, unknown>, backing?: any) => {
    translate(req: BergamotRequest): Promise<BergamotResponse>;
    delete(): Promise<void>;
  };
  TranslatorBacking: new (opts?: Record<string, unknown>) => {
    loadWorker(): Promise<any>;
    loadModelRegistery(): Promise<BergamotModelEntry[]>;
    loadTranslationModel(pair: { from: string; to: string }): Promise<BergamotModelBuffers>;
    getTranslationModel(
      pair: { from: string; to: string },
      opts?: { signal?: AbortSignal }
    ): Promise<BergamotModelBuffers>;
    getModels(pair: { from: string; to: string }): Promise<Array<{ from: string; to: string }>>;
    registryUrl: string;
    buffers: Map<string, Promise<BergamotModelBuffers>>;
    models: Map<string, Promise<any>>;
  };
}

// ---------------------------------------------------------------------------
// Mozilla Firefox Translations model metadata (from GitHub).
// ---------------------------------------------------------------------------

interface MozillaModelMetadata {
  architecture: string; // 'base', 'tiny', 'base-memory'
  sourceLanguage: string;
  targetLanguage: string;
  model_id: string; // e.g. 'en-it'
  baseUrl: string;
  files: {
    model: { path: string; uncompressedSize?: number; uncompressedHash?: string };
    vocab: { path: string };
    lexicalShortlist: { path: string };
  };
  modelStatistics?: {
    parameters: number;
    encoderParameters: number;
    decoderParameters: number;
  };
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** GitHub raw base URL for Mozilla Firefox Translations models. */
const GITHUB_BASE = 'https://raw.githubusercontent.com/mozilla/firefox-translations-models/main';

/** Model index – lists all available language pairs via by-hash.json. */
const MODEL_INDEX_URL = `${GITHUB_BASE}/models/by-hash.json`;

/** Preferred model architecture (best quality with reasonable size). */
const PREFERRED_ARCHITECTURE = 'base-memory';

/** Timeout (ms) of inactivity before the WASM worker is destroyed to free RAM. */
const DEFAULT_UNLOAD_TIMEOUT_MS = 120_000; // 2 minutes

/** Maximum number of concurrent WASM workers. */
const MAX_WORKERS = 1;

// ---------------------------------------------------------------------------
// BergamotModelDownloader
//
// Handles downloading and caching of Mozilla model files from GitHub.
// ---------------------------------------------------------------------------

export class BergamotModelDownloader {
  private readonly modelsDir: string;

  constructor(modelsDir?: string) {
    this.modelsDir = modelsDir ?? ProcessManager.getModelsDirectory();
  }

  /**
   * Returns the local directory for a specific language pair, e.g.
   * `data/models/bergamot/en-it/`.
   */
  pairDir(pair: string): string {
    const p = this.nodeRequire<typeof import('node:path')>('path');
    return p.join(this.modelsDir, 'bergamot', pair);
  }

  /**
   * Fetches the list of available language pairs from Mozilla's GitHub repository.
   */
  async listPairs(): Promise<string[]> {
    const resp = await fetch(MODEL_INDEX_URL);
    if (!resp.ok) {
      throw new Error(`Failed to fetch model index (HTTP ${resp.status}).`);
    }
    const byHash = (await resp.json()) as Record<string, string>;
    // Extract unique pairs from metadata paths like "models/base-memory/enit/metadata.json"
    const pairs = new Set<string>();
    for (const path of Object.values(byHash)) {
      const match = path.match(/models\/([^/]+)\/([a-z]{2})([a-z]{2})\/metadata\.json$/);
      if (match) {
        // Convert compact form "enit" to "en-it" format
        const pair = `${match[2]}-${match[3]}`;
        pairs.add(pair);
      }
    }
    return Array.from(pairs);
  }

  /**
   * Fetches the model metadata JSON for a language pair from Mozilla's GitHub repository.
   * The metadata tells us the architecture and file names for model, vocab, and shortlist.
   */
  async fetchMetadata(pair: string): Promise<MozillaModelMetadata> {
    // pair is like "en-it"; convert to compact form "enit" for GitHub paths
    const compactPair = pair.replace('-', '');
    // Try preferred architecture first, then fall back to others
    const architectures = [PREFERRED_ARCHITECTURE, 'base', 'tiny'];
    let metadata: MozillaModelMetadata | null = null;
    let usedArch = '';

    for (const arch of architectures) {
      const url = `${GITHUB_BASE}/models/${arch}/${compactPair}/metadata.json`;
      const resp = await fetch(url);
      if (resp.ok) {
        metadata = (await resp.json()) as MozillaModelMetadata;
        usedArch = arch;
        break;
      }
    }

    if (!metadata) {
      throw new Error(
        `Failed to fetch model metadata for ${pair}. ` +
          `The language pair may not be available.`
      );
    }

    // Build the baseUrl and file paths from the GitHub structure
    const baseUrl = `${GITHUB_BASE}/models/${usedArch}/${compactPair}`;
    const pairKey = compactPair;

    return {
      architecture: usedArch,
      sourceLanguage: metadata.sourceLanguage ?? pair.split('-')[0],
      targetLanguage: metadata.targetLanguage ?? pair.split('-')[1],
      model_id: pairKey,
      baseUrl,
      files: {
        model: { path: `model.${pairKey}.intgemm.alphas.bin.gz` },
        vocab: { path: `vocab.${pairKey}.spm.gz` },
        lexicalShortlist: { path: `lex.50.50.${pairKey}.s2t.bin.gz` },
      },
      modelStatistics: metadata.modelStatistics,
    };
  }

  /**
   * Downloads a single file from Mozilla's GitHub repository and saves it locally (decompressed).
   * Returns the path to the decompressed file.
   */
  async downloadFile(
    pair: string,
    fileKey: 'model' | 'vocab' | 'lexicalShortlist',
    onProgress?: (pct: number, msg: string) => void
  ): Promise<string> {
    const metadata = await this.fetchMetadata(pair);
    const file = metadata.files[fileKey];
    const url = `${metadata.baseUrl}/${file.path}`;
    const p = this.nodeRequire<typeof import('node:path')>('path');
    const fs = this.nodeRequire<typeof import('node:fs')>('fs');
    const fsPromises = this.nodeRequire<typeof import('node:fs/promises')>('fs/promises');

    // Determine local file name
    const baseName = p.basename(file.path, '.gz');
    const localPath = p.join(this.pairDir(pair), baseName);

    // Check if already downloaded
    if (fs.existsSync(localPath)) {
      return localPath;
    }

    // Ensure directory exists
    await fsPromises.mkdir(p.dirname(localPath), { recursive: true });

    // Download with progress
    const tempPath = `${localPath}.download`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Download failed for ${fileKey} of ${pair}: HTTP ${response.status}`);
    }

    const contentLength = Number(response.headers.get('content-length')) || 0;
    let downloaded = 0;

    // response.body is a Web ReadableStream, not a Node.js stream.
    // We need to convert it to a Node.js compatible stream or read it manually.
    const webStream = response.body;
    if (!webStream) {
      throw new Error(`Empty response body for ${fileKey} of ${pair}`);
    }

    const writeStream = fs.createWriteStream(tempPath);

    // Read the Web ReadableStream chunk by chunk
    const reader = webStream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        downloaded += value.length;
        if (contentLength > 0 && onProgress) {
          const pct = Math.round((downloaded / contentLength) * 100);
          onProgress(pct, `Downloading ${fileKey} (${(downloaded / 1024 / 1024).toFixed(1)} MB)`);
        }
        writeStream.write(value);
      }
    } finally {
      reader.releaseLock();
      writeStream.end();
    }

    // Wait for the write stream to finish
    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', reject);
    });

    // Decompress if gzipped
    if (file.path.endsWith('.gz')) {
      await this.decompress(tempPath, localPath);
      await fsPromises.unlink(tempPath).catch(() => {});
    } else {
      fs.renameSync(tempPath, localPath);
    }

    return localPath;
  }

  /**
   * Downloads all three model files (model, vocab, shortlist) for a pair.
   * Returns the paths to the decompressed files.
   */
  async downloadModel(
    pair: string,
    onProgress?: (pct: number, msg: string) => void
  ): Promise<{ model: string; vocab: string; shortlist: string }> {
    const results = await Promise.all([
      this.downloadFile(pair, 'model', onProgress),
      this.downloadFile(pair, 'vocab', onProgress),
      this.downloadFile(pair, 'lexicalShortlist', onProgress),
    ]);

    return {
      model: results[0],
      vocab: results[1],
      shortlist: results[2],
    };
  }

  /**
   * Checks whether all model files for a pair are already cached locally.
   */
  async isModelCached(pair: string): Promise<boolean> {
    try {
      const metadata = await this.fetchMetadata(pair);
      const p = this.nodeRequire<typeof import('node:path')>('path');
      const fs = this.nodeRequire<typeof import('node:fs')>('fs');

      const files = [metadata.files.model, metadata.files.vocab, metadata.files.lexicalShortlist];
      for (const file of files) {
        const baseName = p.basename(file.path, '.gz');
        const localPath = p.join(this.pairDir(pair), baseName);
        if (!fs.existsSync(localPath)) {
          return false;
        }
      }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Removes cached model files for a language pair.
   */
  async removeModel(pair: string): Promise<void> {
    const fs = this.nodeRequire<typeof import('node:fs/promises')>('fs/promises');
    const dir = this.pairDir(pair);
    if (fs && this.nodeRequire<typeof import('node:fs')>('fs').existsSync(dir)) {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Decompresses a .gz file using Node's zlib.
   */
  private async decompress(input: string, output: string): Promise<void> {
    const zlib = this.nodeRequire<typeof import('node:zlib')>('zlib');
    const fs = this.nodeRequire<typeof import('node:fs')>('fs');
    const fsPromises = this.nodeRequire<typeof import('node:fs/promises')>('fs/promises');

    const data = await fsPromises.readFile(input);
    const decompressed = zlib.gunzipSync(data);
    await fsPromises.writeFile(output, decompressed);
  }

  /**
   * Safe require that works in both Mailspring renderer and main process.
   */
  private nodeRequire<T>(moduleName: string): T {
    try {
      const fn =
        typeof globalThis !== 'undefined' && (globalThis as any).require
          ? (globalThis as any).require
          : typeof require !== 'undefined'
            ? require
            : null;
      if (typeof fn === 'function') {
        return fn(moduleName) as T;
      }
    } catch {
      /* non-node runtime */
    }
    throw new Error(`Cannot load Node.js module: ${moduleName}`);
  }
}

// ---------------------------------------------------------------------------
// LocalTranslatorBacking
//
// Extends TranslatorBacking to load models from the local filesystem instead
// of fetching them from the network. The registry is built from the Mozilla
// GitHub repository metadata.
// ---------------------------------------------------------------------------

export class LocalTranslatorBacking {
  private readonly downloader: BergamotModelDownloader;
  private backing: any; // TranslatorBacking instance (used for worker management)
  private initialized = false;
  private bergamotModule: BergamotModule | null = null;

  constructor(downloader: BergamotModelDownloader) {
    this.downloader = downloader;
  }

  /**
   * Lazy-loads the Bergamot ESM module.
   */
  private async ensureModule(): Promise<BergamotModule> {
    if (!this.bergamotModule) {
      // Dynamic import – works in Node.js 16+ and Electron
      this.bergamotModule = (await import(
        // @ts-ignore - ESM module without types
        '@browsermt/bergamot-translator/translator.js'
      )) as unknown as BergamotModule;
    }
    return this.bergamotModule;
  }

  /**
   * Initializes the underlying TranslatorBacking with a custom registry URL
   * that points to a local registry we build from cached models.
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    const { TranslatorBacking } = await this.ensureModule();

    // Create a backing instance – we'll override its model loading
    this.backing = new TranslatorBacking({
      cacheSize: 0,
      // We don't use the default registry; we build our own
      registryUrl: '',
    });

    // Override loadModelRegistery to return our local registry
    this.backing.loadModelRegistery = async () => {
      return this.buildLocalRegistry();
    };

    // Override getTranslationModel to load from disk
    const originalGetModel = this.backing.getTranslationModel.bind(this.backing);
    this.backing.getTranslationModel = async (
      pair: { from: string; to: string },
      options?: { signal?: AbortSignal }
    ) => {
      return this.loadModelFromDisk(pair, options);
    };

    this.initialized = true;
  }

  /**
   * Builds a Bergamot-compatible registry from locally cached models.
   */
  private async buildLocalRegistry(): Promise<BergamotModelEntry[]> {
    const fs = this.nodeRequire<typeof import('node:fs')>('fs');
    const p = this.nodeRequire<typeof import('node:path')>('path');

    const bergamotDir = p.join(this.downloader['modelsDir'], 'bergamot');
    if (!fs.existsSync(bergamotDir)) return [];

    const entries: BergamotModelEntry[] = [];
    const pairs = fs.readdirSync(bergamotDir);

    for (const pair of pairs) {
      const pairPath = p.join(bergamotDir, pair);
      if (!fs.statSync(pairPath).isDirectory()) continue;

      // Check if all required files exist
      const files = fs.readdirSync(pairPath);
      const hasModel = files.some((f: string) => f.endsWith('.bin'));
      const hasVocab = files.some((f: string) => f.endsWith('.spm'));
      const hasShortlist = files.some((f: string) => f.endsWith('.bin') && f.includes('lex'));

      if (hasModel && hasVocab && hasShortlist) {
        const [from, to] = pair.split('-');
        entries.push({
          from,
          to,
          files: {
            model: { name: `local://${pairPath}`, size: 0 },
            vocab: { name: `local://${pairPath}`, size: 0 },
            lex: { name: `local://${pairPath}`, size: 0 },
          },
        });
      }
    }

    return entries;
  }

  /**
   * Loads model buffers from the local filesystem for a given language pair.
   */
  private async loadModelFromDisk(
    pair: { from: string; to: string },
    _options?: { signal?: AbortSignal }
  ): Promise<BergamotModelBuffers> {
    const fs = this.nodeRequire<typeof import('node:fs/promises')>('fs/promises');
    const p = this.nodeRequire<typeof import('node:path')>('path');

    const pairKey = `${pair.from}-${pair.to}`;
    const pairPath = this.downloader.pairDir(pairKey);

    // Read all files in the pair directory
    const files = await fs.readdir(pairPath);

    let modelBuffer: ArrayBuffer | null = null;
    let shortlistBuffer: ArrayBuffer | null = null;
    const vocabBuffers: ArrayBuffer[] = [];

    for (const file of files) {
      const fullPath = p.join(pairPath, file);
      const data = await fs.readFile(fullPath);
      const buffer = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength
      ) as ArrayBuffer;

      if (file.includes('model') && file.endsWith('.bin')) {
        modelBuffer = buffer;
      } else if (file.includes('lex') && file.endsWith('.bin')) {
        shortlistBuffer = buffer;
      } else if (file.endsWith('.spm')) {
        vocabBuffers.push(buffer);
      }
    }

    if (!modelBuffer) {
      throw new Error(`Model file not found for ${pairKey} in ${pairPath}`);
    }
    if (vocabBuffers.length === 0) {
      throw new Error(`Vocab file not found for ${pairKey} in ${pairPath}`);
    }

    return {
      model: modelBuffer,
      shortlist: shortlistBuffer,
      vocabs: vocabBuffers,
      qualityModel: null,
      config: {
        'gemm-precision': 'int8shiftAlphaAll',
        'beam-size': '1',
        'normalize': '1.0',
        'word-penalty': '0',
        'alignment': 'soft',
        'max-length-break': '128',
        'mini-batch-words': '1024',
        'workspace': '128',
        'max-length-factor': '2.0',
        'skip-cost': 'true',
      },
    };
  }

  /**
   * Creates a translation worker proxy.
   */
  async loadWorker(): Promise<any> {
    await this.initialize();
    return this.backing.loadWorker();
  }

  /**
   * Gets or loads translation model data.
   */
  async getTranslationModel(
    pair: { from: string; to: string },
    options?: { signal?: AbortSignal }
  ): Promise<BergamotModelBuffers> {
    await this.initialize();
    return this.backing.getTranslationModel(pair, options);
  }

  /**
   * Gets the list of models needed for a translation pair.
   */
  async getModels(pair: { from: string; to: string }): Promise<Array<{ from: string; to: string }>> {
    await this.initialize();
    return this.backing.getModels(pair);
  }

  /**
   * Terminates the worker and releases WASM memory.
   */
  async terminate(): Promise<void> {
    if (this.backing) {
      // Clear cached buffers to free memory
      if (this.backing.buffers) {
        this.backing.buffers.clear();
      }
      if (this.backing.models) {
        this.backing.models.clear();
      }
    }
  }

  private nodeRequire<T>(moduleName: string): T {
    try {
      const fn =
        typeof globalThis !== 'undefined' && (globalThis as any).require
          ? (globalThis as any).require
          : typeof require !== 'undefined'
            ? require
            : null;
      if (typeof fn === 'function') {
        return fn(moduleName) as T;
      }
    } catch {
      /* non-node runtime */
    }
    throw new Error(`Cannot load Node.js module: ${moduleName}`);
  }
}

// ---------------------------------------------------------------------------
// BergamotTranslationProvider
//
// Main provider class that implements ITranslationProvider.
// Manages the WASM translator lifecycle, model downloads, and memory cleanup.
// ---------------------------------------------------------------------------

export class BergamotTranslationProvider implements ITranslationProvider {
  private readonly downloader: BergamotModelDownloader;
  private readonly backing: LocalTranslatorBacking;
  private translator: any | null = null; // LatencyOptimisedTranslator instance
  private readonly unloadTimeoutMs: number;
  private unloadTimer: ReturnType<typeof setTimeout> | null = null;
  private isInitialized = false;
  private availabilityError: string | null = null;
  private isAvailableCache: boolean | null = null;
  private readonly languageNames: Map<string, string>;
  private languageDetector: LanguageDetector | null = null;

  constructor(options?: {
    modelsDirectory?: string;
    unloadTimeoutMs?: number;
  }) {
    this.downloader = new BergamotModelDownloader(options?.modelsDirectory);
    this.backing = new LocalTranslatorBacking(this.downloader);
    this.unloadTimeoutMs = options?.unloadTimeoutMs ?? DEFAULT_UNLOAD_TIMEOUT_MS;
    this.languageNames = this.buildLanguageNames();
  }

  // ------------------------------------------------------------------
  // ITranslationProvider implementation
  // ------------------------------------------------------------------

  getInfo(): ProviderInfo {
    return {
      id: 'bergamot',
      name: 'Bergamot WASM (Mozilla Translations)',
      version: '0.4.9',
      platform: ['darwin', 'win32', 'linux'],
      description: this.isAvailableCache
        ? 'WebAssembly translation engine ready. Installed models run offline.'
        : 'Mozilla Bergamot WASM engine for offline neural translation.',
      requiresNPU: false,
      isAvailable: this.isAvailableCache === true,
      unavailabilityReason: this.isAvailableCache
        ? undefined
        : this.availabilityError ??
          'Download a Bergamot model from Offline Models in Preferences.',
      isStandaloneRuntime: true,
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      // Check if Bergamot module can be loaded
      await this.ensureBergamotModule();
      const installed = await this.getInstalledPairs();
      this.isAvailableCache = installed.length > 0;
      this.availabilityError = this.isAvailableCache
        ? null
        : 'No Bergamot models are installed. Download a model from Offline Models in Preferences.';
    } catch (error) {
      this.isAvailableCache = false;
      this.availabilityError = `Bergamot WASM is unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    return this.isAvailableCache;
  }

  async getSupportedLanguages(): Promise<LanguagePair[]> {
    const installed = await this.getInstalledPairs();
    return installed.map((pair) => {
      const [from, to] = pair.split('-');
      return {
        source: from,
        target: to,
        sourceName: this.languageNames.get(from) || from,
        targetName: this.languageNames.get(to) || to,
        installed: true,
        providerId: 'bergamot',
      };
    });
  }

  async detectLanguage(text: string): Promise<LanguageDetectionResult> {
    if (!text.trim()) return { language: 'en', confidence: 1, isReliable: true };

    try {
      if (!this.languageDetector) {
        const LanguageDetect = this.nodeRequire<new () => LanguageDetector>('languagedetect');
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

  async canTranslate(sourceLang: string, targetLang: string): Promise<boolean> {
    if (sourceLang === 'auto') return true; // detection happens upstream
    const pair = `${sourceLang}-${targetLang}`;
    return this.downloader.isModelCached(pair);
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    const startTime = Date.now();

    // Resolve source language
    let sourceLang = request.sourceLang;
    if (sourceLang === 'auto' || !sourceLang) {
      const detected = await this.detectLanguage(request.text);
      sourceLang = detected.language;
    }
    sourceLang = normalizeLanguageTag(sourceLang);
    const targetLang = normalizeLanguageTag(request.targetLang);

    // Ensure the translator is loaded
    await this.ensureTranslator();

    // Translate using Bergamot
    const response = await this.translator.translate({
      from: sourceLang,
      to: targetLang,
      text: request.text,
      html: request.isHtml ?? false,
      qualityScores: false,
    });

    // Reset the unload timer
    this.resetUnloadTimer();

    return {
      id: request.id,
      translatedText: response.target.text,
      detectedSourceLang: sourceLang,
      targetLang,
      providerUsed: 'bergamot',
      providerName: 'Bergamot WASM',
      fromCache: false,
      durationMs: Date.now() - startTime,
    };
  }

  cancel(_requestId: string): void {
    // Bergamot doesn't support per-request cancellation easily.
    // We could abort the current pending request if using LatencyOptimisedTranslator.
  }

  dispose(): void {
    this.stopUnloadTimer();
    this.languageDetector = null;
    this.destroyTranslator();
  }

  // ------------------------------------------------------------------
  // Model management
  // ------------------------------------------------------------------

  async listInstallableModels(): Promise<ModelPackage[]> {
    const pairs = await this.downloader.listPairs();
    const installed = await this.getInstalledPairs();

    return pairs.map((pair) => {
      const [from, to] = pair.split('-');
      return {
        fromCode: from,
        fromName: this.languageNames.get(from) || from,
        toCode: to,
        toName: this.languageNames.get(to) || to,
        packageVersion: 'base',
        sizeMB: 0, // Unknown until downloaded
        isInstalled: installed.includes(pair),
        provider: 'bergamot',
      };
    });
  }

  async installModel(
    fromLang: string,
    toLang: string,
    onProgress?: (percent: number, message: string) => void
  ): Promise<boolean> {
    const pair = `${fromLang}-${toLang}`;

    try {
      // Download all model files
      await this.downloader.downloadModel(pair, onProgress);

      // Clear the backing's registry cache so it picks up the new model
      await this.backing.terminate();
      this.isInitialized = false;

      // Destroy the current translator so it reloads with the new model
      this.destroyTranslator();

      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (onProgress) {
        onProgress(0, `Error: ${msg}`);
      }
      throw new Error(`Failed to install Bergamot model ${pair}: ${msg}`);
    }
  }

  async removeModel(fromLang: string, toLang: string): Promise<boolean> {
    const pair = `${fromLang}-${toLang}`;
    await this.downloader.removeModel(pair);

    // Clear caches
    await this.backing.terminate();
    this.isInitialized = false;
    this.destroyTranslator();

    return true;
  }

  // ------------------------------------------------------------------
  // Internal helpers
  // ------------------------------------------------------------------

  /**
   * Ensures the Bergamot ESM module is loaded.
   */
  private async ensureBergamotModule(): Promise<BergamotModule> {
    try {
      return (await import(
        // @ts-ignore - ESM module without types
        '@browsermt/bergamot-translator/translator.js'
      )) as unknown as BergamotModule;
    } catch (error) {
      throw new Error(
        `Failed to load Bergamot WASM module. ` +
          `Ensure @browsermt/bergamot-translator is installed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Ensures the translator instance is created and ready.
   */
  private async ensureTranslator(): Promise<void> {
    if (this.translator) return;

    const { LatencyOptimisedTranslator } = await this.ensureBergamotModule();

    // Initialize the backing
    await this.backing.initialize();

    // Create the translator with our custom backing
    this.translator = new LatencyOptimisedTranslator(
      {
        cacheSize: 0,
        downloadTimeout: 120000,
      },
      this.backing
    );

    this.isInitialized = true;
    this.resetUnloadTimer();
  }

  /**
   * Destroys the translator and releases WASM memory.
   */
  private async destroyTranslator(): Promise<void> {
    if (this.translator) {
      try {
        await this.translator.delete();
      } catch {
        // Ignore errors during cleanup
      }
      this.translator = null;
    }
    await this.backing.terminate();
    this.isInitialized = false;
  }

  /**
   * Gets the list of installed language pairs.
   */
  private async getInstalledPairs(): Promise<string[]> {
    const fs = this.nodeRequire<typeof import('node:fs')>('fs');
    const p = this.nodeRequire<typeof import('node:path')>('path');

    const bergamotDir = p.join(this.downloader['modelsDir'], 'bergamot');
    if (!fs.existsSync(bergamotDir)) return [];

    const entries = fs.readdirSync(bergamotDir);
    const pairs: string[] = [];

    for (const entry of entries) {
      const entryPath = p.join(bergamotDir, entry);
      if (fs.statSync(entryPath).isDirectory()) {
        pairs.push(entry);
      }
    }

    return pairs;
  }

  /**
   * Starts a timer that will destroy the translator after a period of
   * inactivity, freeing WASM memory.
   */
  private resetUnloadTimer(): void {
    this.stopUnloadTimer();
    this.unloadTimer = setTimeout(async () => {
      // Only unload if there are still models installed (don't break re-init)
      const installed = await this.getInstalledPairs();
      if (installed.length > 0) {
        await this.destroyTranslator();
      }
    }, this.unloadTimeoutMs);
  }

  private stopUnloadTimer(): void {
    if (this.unloadTimer !== null) {
      clearTimeout(this.unloadTimer);
      this.unloadTimer = null;
    }
  }

  /**
   * Builds a map of ISO 639-1 codes to language names.
   */
  private buildLanguageNames(): Map<string, string> {
    return new Map([
      ['af', 'Afrikaans'],
      ['ar', 'Arabic'],
      ['az', 'Azerbaijani'],
      ['bg', 'Bulgarian'],
      ['bn', 'Bengali'],
      ['bs', 'Bosnian'],
      ['ca', 'Catalan'],
      ['cs', 'Czech'],
      ['cy', 'Welsh'],
      ['da', 'Danish'],
      ['de', 'German'],
      ['el', 'Greek'],
      ['en', 'English'],
      ['es', 'Spanish'],
      ['et', 'Estonian'],
      ['eu', 'Basque'],
      ['fa', 'Persian'],
      ['fi', 'Finnish'],
      ['fr', 'French'],
      ['gl', 'Galician'],
      ['gu', 'Gujarati'],
      ['he', 'Hebrew'],
      ['hi', 'Hindi'],
      ['hr', 'Croatian'],
      ['hu', 'Hungarian'],
      ['id', 'Indonesian'],
      ['is', 'Icelandic'],
      ['it', 'Italian'],
      ['ja', 'Japanese'],
      ['kn', 'Kannada'],
      ['ko', 'Korean'],
      ['lt', 'Lithuanian'],
      ['lv', 'Latvian'],
      ['ml', 'Malayalam'],
      ['mr', 'Marathi'],
      ['ms', 'Malay'],
      ['mt', 'Maltese'],
      ['nb', 'Norwegian'],
      ['nl', 'Dutch'],
      ['no', 'Norwegian'],
      ['pl', 'Polish'],
      ['pt', 'Portuguese'],
      ['ro', 'Romanian'],
      ['ru', 'Russian'],
      ['sk', 'Slovak'],
      ['sl', 'Slovenian'],
      ['sq', 'Albanian'],
      ['sr', 'Serbian'],
      ['sv', 'Swedish'],
      ['ta', 'Tamil'],
      ['te', 'Telugu'],
      ['th', 'Thai'],
      ['tr', 'Turkish'],
      ['uk', 'Ukrainian'],
      ['ur', 'Urdu'],
      ['vi', 'Vietnamese'],
      ['zh', 'Chinese'],
    ]);
  }

  private nodeRequire<T>(moduleName: string): T {
    try {
      const fn =
        typeof globalThis !== 'undefined' && (globalThis as any).require
          ? (globalThis as any).require
          : typeof require !== 'undefined'
            ? require
            : null;
      if (typeof fn === 'function') {
        return fn(moduleName) as T;
      }
    } catch {
      /* non-node runtime */
    }
    throw new Error(`Cannot load Node.js module: ${moduleName}`);
  }
}
