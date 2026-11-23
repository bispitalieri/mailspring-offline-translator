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

/** Google Cloud Storage base URL for Mozilla Translations models. */
const GCS_BASE = 'https://storage.googleapis.com/moz-fx-translations-data--303e-prod-translations-data';

/** Model registry JSON – lists all available language pairs and their metadata. */
const MODEL_REGISTRY_URL = `${GCS_BASE}/db/models.json`;

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
   * Fetches the list of available language pairs from Mozilla's GCS model registry.
   */
  async listPairs(): Promise<string[]> {
    const resp = await fetch(MODEL_REGISTRY_URL);
    if (!resp.ok) {
      throw new Error(`Failed to fetch model registry (HTTP ${resp.status}).`);
    }
    const registry = (await resp.json()) as { models: Record<string, unknown[]> };
    // Keys in the models object are the language pairs (e.g., "en-it", "fr-en")
    return Object.keys(registry.models ?? {});
  }

  /**
   * Fetches the model metadata for a language pair from Mozilla's GCS model registry.
   * Prefers models with releaseStatus "Release" and base-memory architecture.
   */
  async fetchMetadata(pair: string): Promise<MozillaModelMetadata> {
    const resp = await fetch(MODEL_REGISTRY_URL);
    if (!resp.ok) {
      throw new Error(`Failed to fetch model registry (HTTP ${resp.status}).`);
    }
    const registry = (await resp.json()) as {
      baseUrl: string;
      models: Record<string, Array<{
        architecture: string;
        releaseStatus?: string;
        sourceLanguage: string;
        targetLanguage: string;
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
      }>>;
    };

    const models = registry.models?.[pair];
    if (!models || models.length === 0) {
      throw new Error(
        `No model found for language pair ${pair}. ` +
          `The language pair may not be available.`
      );
    }

    // Prefer model with releaseStatus "Release" and preferred architecture
    let selected = models.find(m => m.releaseStatus === 'Release' && m.architecture === PREFERRED_ARCHITECTURE)
      ?? models.find(m => m.releaseStatus === 'Release')
      ?? models.find(m => m.architecture === PREFERRED_ARCHITECTURE)
      ?? models[0];

    const baseUrl = registry.baseUrl;
    const pairKey = pair.replace('-', '');

    return {
      architecture: selected.architecture,
      sourceLanguage: selected.sourceLanguage ?? pair.split('-')[0],
      targetLanguage: selected.targetLanguage ?? pair.split('-')[1],
      model_id: pairKey,
      baseUrl,
      files: {
        model: { path: selected.files.model.path, uncompressedSize: selected.files.model.uncompressedSize, uncompressedHash: selected.files.model.uncompressedHash },
        vocab: { path: selected.files.vocab.path },
        lexicalShortlist: { path: selected.files.lexicalShortlist.path },
      },
      modelStatistics: selected.modelStatistics,
    };
  }

  /**
   * Downloads a single file from Mozilla's GCS model storage and saves it locally (decompressed).
   * Returns the path to the decompressed file.
   */
  async downloadFile(
    pair: string,
    fileKey: 'model' | 'vocab' | 'lexicalShortlist',
    onProgress?: (pct: number, msg: string) => void,
    forceRedownload = false
  ): Promise<string> {
    const metadata = await this.fetchMetadata(pair);
    const file = metadata.files[fileKey];
    // GCS paths are relative to baseUrl
    const url = `${metadata.baseUrl}/${file.path}`;
    // Local file name: strip the directory path from GCS, keep only the filename without .gz
    const gcsFileName = file.path.split('/').pop() ?? file.path;
    const baseName = gcsFileName.replace(/\.gz$/, '');
    const p = this.nodeRequire<typeof import('node:path')>('path');
    const fs = this.nodeRequire<typeof import('node:fs')>('fs');
    const fsPromises = this.nodeRequire<typeof import('node:fs/promises')>('fs/promises');

    const localPath = p.join(this.pairDir(pair), baseName);

    // Check if already downloaded (unless forced)
    if (!forceRedownload && fs.existsSync(localPath)) {
      // Verify the file is not empty or corrupted
      const stats = fs.statSync(localPath);
      if (stats.size > 0) {
        return localPath;
      }
      // File exists but is empty, remove it and continue to download
      await fsPromises.unlink(localPath).catch(() => {});
    }

    // Ensure directory exists
    await fsPromises.mkdir(p.dirname(localPath), { recursive: true });

    // Download with progress
    const tempPath = `${localPath}.download`;

    // IMPORTANT: Set Accept-Encoding: identity to prevent Node.js fetch() from
    // auto-decompressing gzip responses. Without this, fetch() decompresses the
    // .gz file on-the-fly, and our subsequent zlib.gunzipSync() call fails with
    // "incorrect header check" because the saved data is already plain bytes.
    const response = await fetch(url, {
      headers: { 'Accept-Encoding': 'identity' },
    });
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
      try {
        await this.decompress(tempPath, localPath);
        await fsPromises.unlink(tempPath).catch(() => {});
      } catch (error) {
        // Clean up the temp file on failure
        await fsPromises.unlink(tempPath).catch(() => {});
        const msg = error instanceof Error ? error.message : String(error);
        throw new Error(`Failed to decompress ${fileKey} for ${pair}: ${msg}. The downloaded file may be corrupted.`);
      }
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
    onProgress?: (pct: number, msg: string) => void,
    forceRedownload = false
  ): Promise<{ model: string; vocab: string; shortlist: string }> {
    const results = await Promise.all([
      this.downloadFile(pair, 'model', onProgress, forceRedownload),
      this.downloadFile(pair, 'vocab', onProgress, forceRedownload),
      this.downloadFile(pair, 'lexicalShortlist', onProgress, forceRedownload),
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
    const fsPromises = this.nodeRequire<typeof import('node:fs/promises')>('fs/promises');

    const data = await fsPromises.readFile(input);
    
    // Check if data looks like gzip (magic bytes: 0x1f 0x8b)
    if (data.length < 2 || data[0] !== 0x1f || data[1] !== 0x8b) {
      throw new Error(
        `File is not in gzip format (magic bytes: 0x${data[0]?.toString(16)} 0x${data[1]?.toString(16)}). ` +
        `The file may have been auto-decompressed by fetch(). Try clearing the model cache and reinstalling.`
      );
    }
    
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
    const result = new Map<string, LanguagePair>();

    // Add direct pairs
    for (const pair of installed) {
      const [from, to] = pair.split('-');
      const key = `${from}-${to}`;
      result.set(key, {
        source: from,
        target: to,
        sourceName: this.languageNames.get(from) || from,
        targetName: this.languageNames.get(to) || to,
        installed: true,
        providerId: 'bergamot',
      });
    }

    // Add pivot pairs (via English) that are not already in the list
    const pivot = 'en';
    const sourcesToPivot = installed
      .filter((p) => p.endsWith(`-${pivot}`))
      .map((p) => p.split('-')[0]);
    const pivotToTargets = installed
      .filter((p) => p.startsWith(`${pivot}-`))
      .map((p) => p.split('-')[1]);

    for (const src of sourcesToPivot) {
      for (const tgt of pivotToTargets) {
        // Skip if source or target is already English (those are direct pairs)
        if (src === pivot || tgt === pivot) continue;
        const key = `${src}-${tgt}`;
        if (!result.has(key)) {
          result.set(key, {
            source: src,
            target: tgt,
            sourceName: this.languageNames.get(src) || src,
            targetName: this.languageNames.get(tgt) || tgt,
            installed: true,
            providerId: 'bergamot',
          });
        }
      }
    }

    return Array.from(result.values());
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
    
    // Check for direct model
    if (await this.downloader.isModelCached(pair)) {
      return true;
    }
    
    // Check for pivot path via English (e.g., cz -> en -> it)
    return this.canPivotTranslate(sourceLang, targetLang);
  }
  
  /**
   * Checks whether a pivot translation path exists via English.
   * For example, if cz -> it is not available but cz -> en and en -> it are,
   * we can translate through English as an intermediate language.
   */
  private async canPivotTranslate(sourceLang: string, targetLang: string): Promise<boolean> {
    if (sourceLang === 'en' || targetLang === 'en') {
      return false; // No pivot needed if one side is already English
    }
    const pivot = 'en';
    const firstHalf = `${sourceLang}-${pivot}`;
    const secondHalf = `${pivot}-${targetLang}`;
    return await this.downloader.isModelCached(firstHalf) && await this.downloader.isModelCached(secondHalf);
  }

  /**
   * Checks whether a pivot translation path can be downloaded via English.
   * Returns the two pairs needed for the pivot path, or null if not available.
   */
  private async getPivotDownloadPath(sourceLang: string, targetLang: string): Promise<{
    firstHalf: string;
    secondHalf: string;
  } | null> {
    if (sourceLang === 'en' || targetLang === 'en') {
      return null; // No pivot needed if one side is already English
    }
    const pivot = 'en';
    const firstHalf = `${sourceLang}-${pivot}`;
    const secondHalf = `${pivot}-${targetLang}`;
    
    // Check if both pivot models are available in the registry
    const availablePairs = await this.downloader.listPairs();
    if (availablePairs.includes(firstHalf) && availablePairs.includes(secondHalf)) {
      return { firstHalf, secondHalf };
    }
    return null;
  }
  
  /**
   * Determines the translation path for a given language pair.
   * Returns the direct pair if available, otherwise a pivot path via English,
   * or null if no path exists.
   */
  private async getTranslationPath(sourceLang: string, targetLang: string): Promise<{
    direct: boolean;
    steps: Array<{ from: string; to: string }>;
  } | null> {
    const directPair = `${sourceLang}-${targetLang}`;
    
    // Check for direct model
    if (await this.downloader.isModelCached(directPair)) {
      return {
        direct: true,
        steps: [{ from: sourceLang, to: targetLang }],
      };
    }
    
    // Check for pivot path via English
    if (sourceLang !== 'en' && targetLang !== 'en') {
      const pivot = 'en';
      const firstHalf = `${sourceLang}-${pivot}`;
      const secondHalf = `${pivot}-${targetLang}`;
      if (await this.downloader.isModelCached(firstHalf) && await this.downloader.isModelCached(secondHalf)) {
        return {
          direct: false,
          steps: [
            { from: sourceLang, to: pivot },
            { from: pivot, to: targetLang },
          ],
        };
      }
    }
    
    return null;
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

    // Determine translation path (direct or via pivot language)
    const path = await this.getTranslationPath(sourceLang, targetLang);

    if (!path) {
      throw new Error(
        `No translation model available for ${sourceLang} -> ${targetLang}. ` +
        `Install the required model(s) from Offline Models in Preferences.`
      );
    }

    // Ensure the translator is loaded
    await this.ensureTranslator();

    let translatedText: string;

    if (path.direct) {
      // Direct translation: source -> target
      const response = await this.translator.translate({
        from: sourceLang,
        to: targetLang,
        text: request.text,
        html: request.isHtml ?? false,
        qualityScores: false,
      });
      translatedText = response.target.text;
    } else {
      // Pivot translation: source -> en -> target
      let intermediateText = request.text;

      for (const step of path.steps) {
        const response = await this.translator.translate({
          from: step.from,
          to: step.to,
          text: intermediateText,
          html: request.isHtml ?? false,
          qualityScores: false,
        });
        intermediateText = response.target.text;
      }
      translatedText = intermediateText;
    }

    // Reset the unload timer
    this.resetUnloadTimer();

    return {
      id: request.id,
      translatedText,
      detectedSourceLang: sourceLang,
      targetLang,
      providerUsed: 'bergamot',
      providerName: path.direct ? 'Bergamot WASM' : 'Bergamot WASM (via English)',
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
    const result = new Map<string, ModelPackage>();

    // Add direct pairs
    for (const pair of pairs) {
      const [from, to] = pair.split('-');
      const key = `${from}-${to}`;
      result.set(key, {
        fromCode: from,
        fromName: this.languageNames.get(from) || from,
        toCode: to,
        toName: this.languageNames.get(to) || to,
        packageVersion: 'base',
        sizeMB: 0, // Unknown until downloaded
        isInstalled: installed.includes(pair),
        provider: 'bergamot',
      });
    }

    // Add pivot pairs (via English) that are not already in the list
    const pivot = 'en';
    const sourcesToPivot = pairs
      .filter((p) => p.endsWith(`-${pivot}`))
      .map((p) => p.split('-')[0]);
    const pivotToTargets = pairs
      .filter((p) => p.startsWith(`${pivot}-`))
      .map((p) => p.split('-')[1]);

    for (const src of sourcesToPivot) {
      for (const tgt of pivotToTargets) {
        // Skip if source or target is already English (those are direct pairs)
        if (src === pivot || tgt === pivot) continue;
        const key = `${src}-${tgt}`;
        if (!result.has(key)) {
          // Check if both pivot models are installed
          const firstHalf = `${src}-${pivot}`;
          const secondHalf = `${pivot}-${tgt}`;
          const isInstalled = installed.includes(firstHalf) && installed.includes(secondHalf);
          
          result.set(key, {
            fromCode: src,
            fromName: this.languageNames.get(src) || src,
            toCode: tgt,
            toName: this.languageNames.get(tgt) || tgt,
            packageVersion: 'base (via English)',
            sizeMB: 0,
            isInstalled,
            provider: 'bergamot',
          });
        }
      }
    }

    return Array.from(result.values());
  }

  async installModel(
    fromLang: string,
    toLang: string,
    onProgress?: (percent: number, message: string) => void
  ): Promise<boolean> {
    const pair = `${fromLang}-${toLang}`;

    try {
      // Check if the direct model exists in the registry
      const availablePairs = await this.downloader.listPairs();
      const hasDirectModel = availablePairs.includes(pair);

      if (hasDirectModel) {
        // Download the direct model
        await this.downloader.downloadModel(pair, onProgress);
      } else {
        // Check if a pivot path is available
        const pivotPath = await this.getPivotDownloadPath(fromLang, toLang);
        if (pivotPath) {
          // Download both pivot models
          const { firstHalf, secondHalf } = pivotPath;
          
          if (onProgress) {
            onProgress(0, `Modello diretto ${pair} non disponibile, download tramite inglese...`);
          }

          // Download first half: source -> en
          if (onProgress) {
            onProgress(0, `Download modello ${firstHalf}...`);
          }
          await this.downloader.downloadModel(firstHalf, (pct, msg) => {
            if (onProgress) {
              onProgress(Math.round(pct / 2), msg);
            }
          });

          // Download second half: en -> target
          if (onProgress) {
            onProgress(50, `Download modello ${secondHalf}...`);
          }
          await this.downloader.downloadModel(secondHalf, (pct, msg) => {
            if (onProgress) {
              onProgress(50 + Math.round(pct / 2), msg);
            }
          });
        } else {
          throw new Error(
            `Nessun modello disponibile per ${pair}. ` +
            `Né il modello diretto né un percorso di traduzione tramite inglese sono disponibili.`
          );
        }
      }

      // Clear the backing's registry cache so it picks up the new model
      await this.backing.terminate();
      this.isInitialized = false;

      // Destroy the current translator so it reloads with the new model
      this.destroyTranslator();

      return true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      
      // If decompression failed, try to force re-download
      if (msg.includes('decompress') || msg.includes('gzip') || msg.includes('incorrect header')) {
        if (onProgress) {
          onProgress(0, 'Decompression failed, clearing cache and retrying...');
        }
        try {
          // Remove corrupted files
          await this.downloader.removeModel(pair);
          // Force re-download
          await this.downloader.downloadModel(pair, onProgress, true);
          await this.backing.terminate();
          this.isInitialized = false;
          this.destroyTranslator();
          return true;
        } catch (retryError) {
          const retryMsg = retryError instanceof Error ? retryError.message : String(retryError);
          if (onProgress) {
            onProgress(0, `Error after retry: ${retryMsg}`);
          }
          throw new Error(`Failed to install Bergamot model ${pair} (even after retry): ${retryMsg}`);
        }
      }
      
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
