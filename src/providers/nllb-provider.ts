/**
 * NLLB-200 Distilled 600M provider backed by Transformers.js (@huggingface/transformers).
 *
 * NLLB-200 (No Language Left Behind) is a multilingual translation model from Meta AI
 * that supports 200 languages using the FLORES-200 language code standard.
 *
 * This provider uses Transformers.js which handles tokenization, target_prefix, and
 * decoding automatically — no manual SentencePiece handling needed.
 *
 * - Downloads the ONNX model from HuggingFace on demand (Xenova/nllb-200-distilled-600M)
 * - Uses @huggingface/transformers pipeline with src_lang and tgt_lang parameters
 * - Implements automatic unload by calling pipe.dispose() after 3 min idle
 * - Loads the model only when the first translation is requested (zero initial memory)
 *
 * Model source: Xenova/nllb-200-distilled-600M (ONNX format for Transformers.js)
 * License: CC-BY-NC-4.0 (non-commercial use only)
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
import { ProcessManager, normalizeLanguageTag } from '../utils';

// ---------------------------------------------------------------------------
// External module type declarations
// ---------------------------------------------------------------------------

/** Language detection via languagedetect. */
interface LanguageDetector {
  detect(text: string, limit: number): Array<[string, number]>;
  setLanguageType(type: 'iso2'): void;
}

/** Transformers.js pipeline for translation. */
interface TranslationPipeline {
  (text: string | string[], options: {
    src_lang: string;
    tgt_lang: string;
    max_length?: number;
  }): Promise<Array<{ translation_text: string }>>;
  dispose(): void;
}

/** Transformers.js pipeline factory. */
interface TransformersPipeline {
  (
    task: 'translation',
    model: string,
    options?: {
      cache_dir?: string;
      progress_callback?: (progress: any) => void;
      dtype?: string | Record<string, string>;
    }
  ): Promise<TranslationPipeline>;
}

/** Transformers.js env config. */
interface TransformersEnv {
  cacheDir?: string;
  useFSCache?: boolean;
  useFS?: boolean;
  version?: string;
  localModelPath?: string;
  allowRemoteModels?: boolean;
  allowLocalModels?: boolean;
}

/** Transformers.js module. */
interface TransformersModule {
  pipeline: TransformersPipeline;
  env: TransformersEnv;
}

// ---------------------------------------------------------------------------
// FLORES-200 language code mapping (ISO 639-1 → FLORES-200)
// ---------------------------------------------------------------------------

/**
 * Maps ISO 639-1 language codes to FLORES-200 codes used by NLLB-200.
 * NLLB requires codes like "eng_Latn", "ita_Latn", "jpn_Jpan", etc.
 */
const ISO_TO_FLORES: Record<string, string> = {
  af: 'afr_Latn',
  am: 'amh_Ethi',
  ar: 'arb_Arab',
  as: 'asm_Beng',
  az: 'azj_Latn',
  be: 'bel_Cyrl',
  bg: 'bul_Cyrl',
  bn: 'ben_Beng',
  br: 'bre_Latn',
  bs: 'bos_Latn',
  ca: 'cat_Latn',
  cs: 'ces_Latn',
  cy: 'cym_Latn',
  da: 'dan_Latn',
  de: 'deu_Latn',
  el: 'ell_Grek',
  en: 'eng_Latn',
  es: 'spa_Latn',
  et: 'est_Latn',
  fa: 'pes_Arab',
  fi: 'fin_Latn',
  fr: 'fra_Latn',
  gl: 'glg_Latn',
  gu: 'guj_Gujr',
  ha: 'hau_Latn',
  he: 'heb_Hebr',
  hi: 'hin_Deva',
  hr: 'hrv_Latn',
  hu: 'hun_Latn',
  hy: 'hye_Armn',
  id: 'ind_Latn',
  is: 'isl_Latn',
  it: 'ita_Latn',
  ja: 'jpn_Jpan',
  ka: 'kat_Geor',
  kk: 'kaz_Cyrl',
  km: 'khm_Khmr',
  kn: 'kan_Knda',
  ko: 'kor_Hang',
  ku: 'kmr_Latn',
  ky: 'kir_Cyrl',
  lo: 'lao_Laoo',
  lt: 'lit_Latn',
  lv: 'lva_Latn',
  mg: 'mlg_Latn',
  mk: 'mkd_Cyrl',
  ml: 'mal_Mlym',
  mn: 'mon_Cyrl',
  mr: 'mar_Deva',
  ms: 'msa_Latn',
  mt: 'mlt_Latn',
  my: 'mya_Mymr',
  ne: 'nep_Deva',
  nl: 'nld_Latn',
  no: 'nor_Latn',
  or: 'ori_Orya',
  pa: 'pan_Guru',
  pl: 'pol_Latn',
  ps: 'pus_Arab',
  pt: 'por_Latn',
  ro: 'ron_Latn',
  ru: 'rus_Cyrl',
  sd: 'snd_Arab',
  si: 'sin_Sinh',
  sk: 'slk_Latn',
  sl: 'slv_Latn',
  sq: 'sqi_Latn',
  sr: 'srp_Cyrl',
  sv: 'swe_Latn',
  sw: 'swh_Latn',
  ta: 'tam_Taml',
  te: 'tel_Telu',
  tg: 'tgk_Cyrl',
  th: 'tha_Thai',
  tk: 'tuk_Latn',
  tl: 'tgl_Latn',
  tr: 'tur_Latn',
  uk: 'ukr_Cyrl',
  ur: 'urd_Arab',
  uz: 'uzn_Latn',
  vi: 'vie_Latn',
  xh: 'xho_Latn',
  zh: 'zho_Hans',
  zu: 'zul_Latn',
};

/**
 * Converts an ISO 639-1 language code to the corresponding FLORES-200 code.
 * Falls back to a best-effort guess if the code is not in the map.
 */
export function isoToFlores(isoCode: string): string {
  const normalized = normalizeLanguageTag(isoCode);
  return ISO_TO_FLORES[normalized] || `${normalized}_Latn`;
}

/**
 * Reverse lookup: FLORES-200 → ISO 639-1 (for display purposes).
 */
const FLORES_TO_ISO: Record<string, string> = {};
for (const [iso, flores] of Object.entries(ISO_TO_FLORES)) {
  FLORES_TO_ISO[flores] = iso;
}

// ---------------------------------------------------------------------------
// Model configuration
// ---------------------------------------------------------------------------

// Transformers.js model ID (ONNX format)
const TRANSFORMERS_MODEL_ID = 'Xenova/nllb-200-distilled-600M';

// Local model folder name (where we manually download the model files)
const LOCAL_MODEL_FOLDER = 'nllb-200-distilled-600M';

// We consider the model "installed" when the local model folder exists
// with the required files.
const MODEL_METADATA_FILE = '.mailspring-model.json';

// HuggingFace Hub API base URL
const HF_HUB_URL = 'https://huggingface.co';

// The files required by Transformers.js for the NLLB-200 model.
// NLLB uses an encoder-decoder architecture, so both encoder and decoder ONNX files are needed.
// We use the q4f16 quantized versions (smallest with good quality):
//   encoder_model_q4f16.onnx (~612 MB) + decoder_model_merged_q4f16.onnx (~642 MB) = ~1.25 GB total.
// The standard FP16 files would be ~3.4 GB, causing RAM spikes to 6-10 GB in Electron.
// After download, files are renamed to the standard names expected by Transformers.js.
const REQUIRED_FILES = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'sentencepiece.bpe.model',
  'onnx/encoder_model_q4f16.onnx',
  'onnx/decoder_model_merged_q4f16.onnx',
];

// Standard names expected by Transformers.js (after renaming from _q4f16).
const EXPECTED_FILES = [
  'config.json',
  'generation_config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'sentencepiece.bpe.model',
  'onnx/encoder_model.onnx',
  'onnx/decoder_model.onnx',
];

// Auto-unload idle timeout: 3 minutes (in milliseconds)
const AUTO_UNLOAD_TIMEOUT_MS = 3 * 60 * 1000;

// Estimated model size on disk (~1.25 GB for q4f16 quantized ONNX)
const ESTIMATED_SIZE_MB = 1250;

// Download timeout: 15 minutes (in milliseconds)
// Large models can take a while to download, especially on slow connections
const DOWNLOAD_TIMEOUT_MS = 15 * 60 * 1000;

// ---------------------------------------------------------------------------
// NLLB Translation Provider
// ---------------------------------------------------------------------------

export class NllbTranslationProvider implements ITranslationProvider {
  private readonly modelsDirectory: string;

  // Transformers.js translation pipeline — disposed on auto-unload to free RAM.
  private pipeline: TranslationPipeline | null = null;

  // Language detection.
  private languageDetector: LanguageDetector | null = null;

  // Availability cache.
  private availabilityError: string | null = null;
  private isAvailableCache: boolean | null = null;

  // Auto-unload timer: disposes the pipeline after idle timeout.
  private unloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(customBaseDir?: string) {
    if (customBaseDir) {
      const path = this.getNodeModule<typeof import('path')>('path');
      this.modelsDirectory = path.join(customBaseDir, 'data', 'models');
    } else {
      this.modelsDirectory = ProcessManager.getModelsDirectory();
    }
  }

  // -----------------------------------------------------------------------
  // ITranslationProvider implementation
  // -----------------------------------------------------------------------

  public getInfo(): ProviderInfo {
    return {
      id: 'nllb',
      name: 'NLLB-200 (Transformers.js)',
      version: '1.0.0',
      platform: ['darwin', 'win32', 'linux'],
      description: this.isAvailableCache
        ? 'NLLB-200 distilled 600M model is installed. Loads on-demand, auto-unloads after 3 min.'
        : 'Meta NLLB-200 neural translation (200 languages). Downloads ~1.25 GB quantized model on demand.',
      requiresNPU: false,
      isAvailable: this.isAvailableCache === true,
      unavailabilityReason: this.isAvailableCache
        ? undefined
        : this.availabilityError ?? 'Download the NLLB-200 model from Offline Models in Preferences.',
    };
  }

  public async isAvailable(): Promise<boolean> {
    try {
      const installed = await this.isModelInstalled();

      // Verify Transformers.js module is available
      this.getTransformers();

      this.isAvailableCache = installed;
      this.availabilityError = installed ? null : 'NLLB-200 model files not found.';
    } catch (error) {
      this.isAvailableCache = false;
      this.availabilityError = error instanceof Error
        ? error.message
        : String(error);
    }

    return this.isAvailableCache;
  }

  public async getSupportedLanguages(): Promise<LanguagePair[]> {
    // NLLB supports all FLORES-200 language pairs (200x199 directions)
    // Return the mapped ISO codes for display
    const pairs: LanguagePair[] = [];
    const isoCodes = Object.keys(ISO_TO_FLORES);

    for (const src of isoCodes) {
      for (const tgt of isoCodes) {
        if (src === tgt) continue;
        pairs.push({
          source: src,
          target: tgt,
          sourceName: this.getLanguageName(src),
          targetName: this.getLanguageName(tgt),
          installed: await this.isModelInstalled(),
          modelSizeMB: ESTIMATED_SIZE_MB,
          providerId: 'nllb',
        });
      }
    }

    return pairs;
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

  public async canTranslate(_sourceLang: string, _targetLang: string): Promise<boolean> {
    // NLLB supports all 200x199 language pairs — just check if the model is installed
    return await this.isAvailable();
  }

  /**
   * Translates text using NLLB-200 via Transformers.js.
   *
   * Transformers.js handles all the complexity:
   * - SentencePiece tokenization with FLORES-200 language codes
   * - Target prefix for guided decoding (tgt_lang parameter)
   * - Output decoding back to readable text
   *
   * We simply pass src_lang and tgt_lang in FLORES-200 format.
   */
  public async translate(request: TranslationRequest): Promise<TranslationResult> {
    const start = Date.now();

    // Reset the auto-unload timer on every translation request
    this.resetUnloadTimer();

    // Resolve source language
    let source = request.sourceLang;
    if (source === 'auto' || !source) {
      const detected = await this.detectLanguage(request.text);
      source = detected.language;
    }
    source = normalizeLanguageTag(source);
    const target = normalizeLanguageTag(request.targetLang);

    // Convert to FLORES-200 codes
    const sourceFlores = isoToFlores(source);
    const targetFlores = isoToFlores(target);

    // Ensure the pipeline is loaded (on-demand)
    await this.ensureLoaded();

    // Split text into sentences for better translation quality
    const sentences = this.splitIntoSentences(request.text);
    const translatedSentences: string[] = [];

    for (const sentence of sentences) {
      // Transformers.js handles tokenization, target_prefix, and decoding automatically
      const results = await this.pipeline!(sentence, {
        src_lang: sourceFlores,
        tgt_lang: targetFlores,
        max_length: 512,
      });

      if (!results[0] || !results[0].translation_text) {
        throw new Error(`NLLB returned no translation for ${sourceFlores} -> ${targetFlores}.`);
      }

      translatedSentences.push(results[0].translation_text);
    }

    const translatedText = translatedSentences.join('');

    return {
      id: request.id,
      translatedText,
      detectedSourceLang: source,
      targetLang: target,
      providerUsed: 'nllb',
      providerName: 'NLLB-200 (Transformers.js)',
      fromCache: false,
      durationMs: Date.now() - start,
    };
  }

  public cancel(_requestId: string): void {
    // Transformers.js doesn't support mid-inference cancellation
  }

  /**
   * Disposes the provider, immediately destroying the pipeline
   * to free all RAM (~470 MB for ONNX model).
   */
  public dispose(): void {
    // Cancel any pending auto-unload timer
    this.cancelUnloadTimer();

    // Dispose the pipeline to free RAM immediately
    if (this.pipeline) {
      try {
        this.pipeline.dispose();
      } catch {
        // Ignore disposal errors
      }
      this.pipeline = null;
    }

    this.languageDetector = null;
    this.isAvailableCache = null;
    this.availabilityError = null;
  }

  // -----------------------------------------------------------------------
  // Model management (download / install / remove)
  // -----------------------------------------------------------------------

  /**
   * Returns a single "installable" model package representing the NLLB-200 model.
   * Unlike Argos/OPUS which have per-pair models, NLLB is a single multilingual model.
   */
  public async listInstallableModels(): Promise<ModelPackage[]> {
    const installed = await this.isModelInstalled();
    return [
      {
        fromCode: 'multilingual',
        fromName: 'Multilingual (200 languages)',
        toCode: 'multilingual',
        toName: 'Multilingual (200 languages)',
        packageVersion: 'onnx-transformersjs',
        sizeMB: ESTIMATED_SIZE_MB,
        isInstalled: installed,
        downloadUrl: `https://huggingface.co/${TRANSFORMERS_MODEL_ID}`,
        provider: 'nllb',
      },
    ];
  }

  /**
   * "Installs" the NLLB model by triggering a download via Transformers.js.
   * Transformers.js handles the download automatically when the pipeline is first created.
   * We use progress_callback to report download progress and a timeout to prevent
   * silent failures in Electron environments.
   */
  public async installModel(
    _fromLang: string,
    _toLang: string,
    onProgress?: (percent: number, message: string) => void
  ): Promise<boolean> {
    const fs = this.getNodeModule<typeof import('fs')>('fs');
    const path = this.getNodeModule<typeof import('path')>('path');
    
    // Download the model manually from HuggingFace Hub
    // This is more reliable than relying on Transformers.js auto-download
    const modelDir = path.join(this.modelsDirectory, LOCAL_MODEL_FOLDER);

    try {
      onProgress?.(0, 'Starting NLLB-200 model download...');
      console.log('[NLLB] Starting manual model download to:', modelDir);

      // Create the model directory
      await fs.promises.mkdir(modelDir, { recursive: true });

      // Check which files already exist and download only the missing ones.
      // We check for the EXPECTED_FILES (standard names) since previous installs
      // may have already renamed the quantized files.
      const filesToDownload: string[] = [];
      
      // First, check if the standard-named files already exist (from a previous install)
      let standardFilesExist = true;
      for (const file of EXPECTED_FILES) {
        const filePath = path.join(modelDir, file);
        try {
          await fs.promises.access(filePath);
          console.log(`[NLLB] Skipping existing file: ${file}`);
        } catch {
          standardFilesExist = false;
          break;
        }
      }
      
      if (standardFilesExist) {
        console.log('[NLLB] All required files already exist with standard names');
      } else {
        // Standard files don't all exist, check which REQUIRED_FILES need downloading
        for (const file of REQUIRED_FILES) {
          const filePath = path.join(modelDir, file);
          try {
            await fs.promises.access(filePath);
            console.log(`[NLLB] Skipping existing file: ${file}`);
          } catch {
            filesToDownload.push(file);
          }
        }
      }

      if (filesToDownload.length === 0) {
        console.log('[NLLB] All required files already exist');
      }

      // Download each missing file from HuggingFace Hub
      let totalDownloaded = 0;
      const totalFiles = filesToDownload.length;

      for (const file of filesToDownload) {
        const fileIndex = filesToDownload.indexOf(file);
        const progressPercent = Math.round((fileIndex / totalFiles) * 85);
        
        onProgress?.(progressPercent, `Downloading ${file}...`);
        console.log(`[NLLB] Downloading ${file}...`);

        const filePath = path.join(modelDir, file);
        await this.downloadFileFromHub(
          TRANSFORMERS_MODEL_ID,
          file,
          filePath,
          (loaded, total) => {
            // Update progress within the current file download
            const fileProgress = total > 0 ? Math.round((loaded / total) * 100) : 0;
            const overallProgress = Math.round(
              (fileIndex / totalFiles) * 85 + (fileProgress / totalFiles) * 85
            );
            onProgress?.(overallProgress, `Downloading ${file}... (${fileProgress}%)`);
          }
        );

        totalDownloaded++;
        console.log(`[NLLB] Downloaded ${file} (${totalDownloaded}/${totalFiles})`);
      }

      // Rename quantized files to the standard names expected by Transformers.js.
      // Transformers.js looks for encoder_model.onnx and decoder_model.onnx,
      // but we downloaded the smaller q4f16 quantized versions.
      onProgress?.(90, 'Preparing model files...');
      console.log('[NLLB] Renaming quantized files to standard names...');

      const renames = [
        ['onnx/encoder_model_q4f16.onnx', 'onnx/encoder_model.onnx'],
        ['onnx/decoder_model_merged_q4f16.onnx', 'onnx/decoder_model.onnx'],
      ];

      for (const [from, to] of renames) {
        const fromPath = path.join(modelDir, from);
        const toPath = path.join(modelDir, to);
        try {
          await fs.promises.access(fromPath);
          // Remove the destination file if it already exists (e.g., from a previous install)
          try {
            await fs.promises.unlink(toPath);
          } catch {
            // Destination doesn't exist, ignore
          }
          await fs.promises.rename(fromPath, toPath);
          console.log(`[NLLB] Renamed ${from} -> ${to}`);
        } catch (err) {
          console.warn(`[NLLB] Could not rename ${from} -> ${to}:`, err instanceof Error ? err.message : String(err));
        }
      }

      onProgress?.(95, 'Verifying model files...');
      console.log('[NLLB] Verifying model files...');

      // Verify all expected files exist (with standard names after renaming)
      for (const file of EXPECTED_FILES) {
        const filePath = path.join(modelDir, file);
        try {
          await fs.promises.access(filePath);
        } catch {
          throw new Error(`Required file not found after download: ${file}`);
        }
      }

      // Write metadata file to mark the model as installed
      const metadata = {
        fromCode: 'multilingual',
        fromName: 'Multilingual (200 languages)',
        toCode: 'multilingual',
        toName: 'Multilingual (200 languages)',
        packageVersion: 'onnx-transformersjs',
        sizeMB: ESTIMATED_SIZE_MB,
        isInstalled: true,
        provider: 'nllb',
        modelPath: LOCAL_MODEL_FOLDER,
        installedAt: Date.now(),
      };

      await fs.promises.writeFile(
        path.join(modelDir, MODEL_METADATA_FILE),
        JSON.stringify(metadata, null, 2),
        'utf8'
      );
      console.log('[NLLB] Metadata file written');

      // Reset availability cache so isAvailable() re-checks
      this.isAvailableCache = null;
      this.availabilityError = null;

      onProgress?.(100, 'NLLB-200 model installed and ready!');
      console.log('[NLLB] Model installation complete');
      return true;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error('[NLLB] Model installation failed:', errorMessage);
      this.availabilityError = errorMessage;
      throw error;
    }
  }

  /**
   * Downloads a file from HuggingFace Hub.
   * Uses the resolve endpoint to get the direct download URL.
   */
  private async downloadFileFromHub(
    modelId: string,
    filePath: string,
    destinationPath: string,
    onProgress?: (loaded: number, total: number) => void
  ): Promise<void> {
    const fs = this.getNodeModule<typeof import('fs')>('fs');
    const path = this.getNodeModule<typeof import('path')>('path');
    
    // Ensure the destination directory exists
    await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });

    // Construct the download URL from HuggingFace Hub
    const downloadUrl = `${HF_HUB_URL}/${modelId}/resolve/main/${filePath}`;
    console.log(`[NLLB] Downloading from: ${downloadUrl}`);

    // Fetch the file
    const response = await fetch(downloadUrl, {
      headers: {
        'Accept': 'application/octet-stream',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to download ${filePath}: HTTP ${response.status} ${response.statusText}`);
    }

    // Get content length for progress tracking
    const contentLength = response.headers.get('content-length');
    const total = contentLength ? parseInt(contentLength, 10) : 0;
    let loaded = 0;

    // Read the response body and write to file
    const fileStream = fs.createWriteStream(destinationPath);
    const reader = response.body?.getReader();
    
    if (!reader) {
      throw new Error('Failed to get reader from response body');
    }

    try {
      while (true) {
        const { done, value } = await reader.read();
        
        if (done) {
          break;
        }

        fileStream.write(value);
        loaded += value.length;
        
        if (onProgress && total > 0) {
          onProgress(loaded, total);
        }
      }
    } finally {
      // Close the write stream
      await new Promise<void>((resolve, reject) => {
        fileStream.end((err: NodeJS.ErrnoException | null) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }

    console.log(`[NLLB] Downloaded ${filePath} (${loaded} bytes)`);
  }

  public async removeModel(_fromLang: string, _toLang: string): Promise<boolean> {
    const fs = this.getNodeModule<typeof import('fs')>('fs');
    const path = this.getNodeModule<typeof import('path')>('path');
    const modelDir = path.join(this.modelsDirectory, LOCAL_MODEL_FOLDER);
    // Also remove the Transformers.js cache structure
    const cacheBase = path.join(this.modelsDirectory, 'models--Xenova--nllb-200-distilled-600M');

    try {
      await fs.promises.access(modelDir);
    } catch {
      return false;
    }

    // Unload the model first
    this.dispose();

    // Remove both the local model directory and the cache symlinks structure
    await fs.promises.rm(modelDir, { recursive: true, force: true });
    try {
      await fs.promises.rm(cacheBase, { recursive: true, force: true });
      console.log('[NLLB] Cache symlinks removed:', cacheBase);
    } catch {
      // Cache might not exist, ignore
    }

    this.isAvailableCache = false;
    this.availabilityError = 'NLLB-200 model has been removed.';

    return true;
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Checks if the NLLB model local directory exists with the required files.
   * We check for the metadata file or the presence of required model files.
   */
  private async isModelInstalled(): Promise<boolean> {
    const fs = this.getNodeModule<typeof import('fs')>('fs');
    const path = this.getNodeModule<typeof import('path')>('path');
    const modelDir = path.join(this.modelsDirectory, LOCAL_MODEL_FOLDER);

    // Check for the metadata file
    const metadataFile = path.join(modelDir, MODEL_METADATA_FILE);

    try {
      await fs.promises.access(metadataFile);
      return true;
    } catch {
      // Fallback: check if the expected files exist (standard names after renaming)
      try {
        for (const file of EXPECTED_FILES) {
          const filePath = path.join(modelDir, file);
          await fs.promises.access(filePath);
        }
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Ensures the Transformers.js pipeline is loaded.
   * Implements on-demand loading: the model is loaded only when first needed.
   * If the model was previously unloaded (via auto-unload), it is reloaded here.
   *
   * CRITICAL: Uses symlinks instead of copying files to avoid doubling disk usage
   * and RAM spikes. The model files are ~1.25 GB on disk; copying them to a cache
   * directory would double the disk usage and cause RAM to spike to 6-10 GB during
   * the copy + load process in Electron.
   */
  private async ensureLoaded(): Promise<void> {
    if (!this.pipeline) {
      const transformers = this.getTransformers();
      const path = this.getNodeModule<typeof import('path')>('path');
      const fs = this.getNodeModule<typeof import('fs')>('fs');

      const modelDir = path.join(this.modelsDirectory, LOCAL_MODEL_FOLDER);
      const cacheBase = path.join(this.modelsDirectory, 'models--Xenova--nllb-200-distilled-600M');
      const snapshotsDir = path.join(cacheBase, 'snapshots', 'main');

      // Check if the Transformers.js cache structure already exists
      let cacheExists = false;
      try {
        await fs.promises.access(snapshotsDir);
        cacheExists = true;
      } catch {
        cacheExists = false;
      }

      if (!cacheExists) {
        console.log('[NLLB] Creating Transformers.js cache symlinks from local model...');

        // Create the cache directory structure
        await fs.promises.mkdir(snapshotsDir, { recursive: true });

        // Use symlinks instead of copying to avoid doubling disk usage and RAM spikes.
        // Copying ~1.25 GB of ONNX files caused RAM to spike to 6-10 GB in Electron.
        const entries = await fs.promises.readdir(modelDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name.startsWith('.')) continue; // Skip hidden files

          const srcPath = path.join(modelDir, entry.name);
          const destPath = path.join(snapshotsDir, entry.name);

          if (entry.isDirectory()) {
            await this.symlinkDirectory(srcPath, destPath, fs, path);
          } else {
            await fs.promises.symlink(srcPath, destPath);
          }
        }

        // Create the refs/main file pointing to the snapshot
        const refsDir = path.join(cacheBase, 'refs');
        await fs.promises.mkdir(refsDir, { recursive: true });
        await fs.promises.writeFile(path.join(refsDir, 'main'), 'main', 'utf8');

        console.log('[NLLB] Cache symlinks created at:', snapshotsDir);
      }

      console.log('[NLLB] Loading pipeline from cache:', snapshotsDir);

      // Load using the model ID - Transformers.js will find it in the cache.
      // CRITICAL: Use dtype 'q4' (4-bit quantization) to reduce RAM usage from ~6 GB to ~2 GB.
      // The per-module dtype ensures encoder and decoder are quantized while keeping
      // embeddings at higher precision for better translation quality.
      this.pipeline = await transformers.pipeline('translation', TRANSFORMERS_MODEL_ID, {
        dtype: {
          encoder_model: 'q4',
          decoder_model: 'q4',
        },
      });
    }
  }

  /**
   * Recursively creates symlinks from source directory to destination.
   * Uses symlinks instead of copying to avoid doubling disk usage and RAM spikes.
   */
  private async symlinkDirectory(
    src: string,
    dest: string,
    fs: typeof import('fs'),
    path: typeof import('path')
  ): Promise<void> {
    await fs.promises.mkdir(dest, { recursive: true });
    const entries = await fs.promises.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);

      if (entry.isDirectory()) {
        await this.symlinkDirectory(srcPath, destPath, fs, path);
      } else {
        await fs.promises.symlink(srcPath, destPath);
      }
    }
  }

  /**
   * Splits text into sentences for better translation quality.
   * NLLB works best with single sentences.
   */
  private splitIntoSentences(text: string): string[] {
    // For short texts, translate as a single unit
    if (text.length <= 300) {
      return [text];
    }

    const sentences: string[] = [];
    // Split after sentence-ending punctuation, preserving delimiters
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

    // Fallback: split by lines if no punctuation found
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

    // Last fallback: return the whole text
    if (sentences.length === 0) {
      return [text];
    }

    return sentences;
  }

  // -----------------------------------------------------------------------
  // Auto-unload timer management
  // -----------------------------------------------------------------------

  /**
   * Resets the auto-unload timer. Called after every successful translation.
   * If no translation is requested within the timeout period, the model is
   * automatically unloaded from memory to free RAM.
   */
  private resetUnloadTimer(): void {
    this.cancelUnloadTimer();

    this.unloadTimer = setTimeout(() => {
      this.autoUnload();
    }, AUTO_UNLOAD_TIMEOUT_MS);

    // Prevent the timer from keeping the process alive
    if (this.unloadTimer.unref) {
      this.unloadTimer.unref();
    }
  }

  /**
   * Cancels any pending auto-unload timer.
   */
  private cancelUnloadTimer(): void {
    if (this.unloadTimer !== null) {
      clearTimeout(this.unloadTimer);
      this.unloadTimer = null;
    }
  }

  /**
   * Automatically unloads the model from memory after the idle timeout.
   * This frees all RAM used by the model weights (~470 MB for ONNX).
   * The model will be reloaded on-demand when the next translation is requested.
   */
  private autoUnload(): void {
    if (this.pipeline) {
      try {
        this.pipeline.dispose();
      } catch {
        // Ignore disposal errors
      }
      this.pipeline = null;
    }
    this.unloadTimer = null;
  }

  // -----------------------------------------------------------------------
  // Module loading helpers
  // -----------------------------------------------------------------------

  private getTransformers(): TransformersModule {
    const transformers = this.getNodeModule<TransformersModule>('@huggingface/transformers');
    
    // CRITICAL: Set cacheDir immediately after loading the module, before any other operation.
    // If env.cacheDir is not set before the first pipeline() call, Transformers.js will use
    // its default cache directory (./.cache relative to CWD) instead of our models directory.
    if (transformers.env.cacheDir !== this.modelsDirectory) {
      transformers.env.cacheDir = this.modelsDirectory;
      // useFSCache is the property name in Transformers.js v3 and v4
      transformers.env.useFSCache = true;
      console.log('[NLLB] Transformers.js cache directory set to:', this.modelsDirectory);
      console.log('[NLLB] Current working directory:', process.cwd());
    }
    
    return transformers;
  }

  private getLanguageName(isoCode: string): string {
    // Use Intl.DisplayNames if available
    try {
      if (typeof Intl !== 'undefined' && (Intl as any).DisplayNames) {
        const dn = new (Intl as any).DisplayNames(['en'], { type: 'language' });
        const name = dn.of(isoCode);
        if (name) return name;
      }
    } catch {
      // Fallback to static names
    }

    // Static fallback names
    const names: Record<string, string> = {
      af: 'Afrikaans', am: 'Amharic', ar: 'Arabic', as: 'Assamese', az: 'Azerbaijani',
      be: 'Belarusian', bg: 'Bulgarian', bn: 'Bengali', br: 'Breton', bs: 'Bosnian',
      ca: 'Catalan', cs: 'Czech', cy: 'Welsh', da: 'Danish', de: 'German',
      el: 'Greek', en: 'English', es: 'Spanish', et: 'Estonian', fa: 'Persian',
      fi: 'Finnish', fr: 'French', gl: 'Galician', gu: 'Gujarati', ha: 'Hausa',
      he: 'Hebrew', hi: 'Hindi', hr: 'Croatian', hu: 'Hungarian', hy: 'Armenian',
      id: 'Indonesian', is: 'Icelandic', it: 'Italian', ja: 'Japanese', ka: 'Georgian',
      kk: 'Kazakh', km: 'Khmer', kn: 'Kannada', ko: 'Korean', ku: 'Kurdish',
      ky: 'Kyrgyz', lo: 'Lao', lt: 'Lithuanian', lv: 'Latvian', mg: 'Malagasy',
      mk: 'Macedonian', ml: 'Malayalam', mn: 'Mongolian', mr: 'Marathi',
      ms: 'Malay', mt: 'Maltese', my: 'Burmese', ne: 'Nepali', nl: 'Dutch',
      no: 'Norwegian', or: 'Odia', pa: 'Punjabi', pl: 'Polish', ps: 'Pashto',
      pt: 'Portuguese', ro: 'Romanian', ru: 'Russian', sd: 'Sindhi', si: 'Sinhala',
      sk: 'Slovak', sl: 'Slovenian', sq: 'Albanian', sr: 'Serbian', sv: 'Swedish',
      sw: 'Swahili', ta: 'Tamil', te: 'Telugu', tg: 'Tajik', th: 'Thai',
      tk: 'Turkmen', tl: 'Tagalog', tr: 'Turkish', uk: 'Ukrainian', ur: 'Urdu',
      uz: 'Uzbek', vi: 'Vietnamese', xh: 'Xhosa', zh: 'Chinese', zu: 'Zulu',
    };

    return names[isoCode] || isoCode.toUpperCase();
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
