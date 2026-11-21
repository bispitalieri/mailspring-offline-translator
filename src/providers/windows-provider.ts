/**
 * Windows Edge Translator API Provider
 *
 * Uses the Microsoft Edge / Chromium Translator API for native, on-device
 * offline translation. Spawns a headless Edge instance and communicates via
 * IPC JSON Lines (same protocol as the Apple helper).
 *
 * Requirements:
 *   - Windows 10/11 with Microsoft Edge (Chromium) installed
 *   - Edge 148+ for Translator API support (Chrome 138+ also supported)
 */

import { ITranslationProvider } from './provider-interface';
import {
  LanguageDetectionResult,
  LanguagePair,
  ProviderInfo,
  TranslationRequest,
  TranslationResult,
} from '../types';
import { JsonLinesIpcClient } from '../utils/ipc-helper';
import { normalizeLanguageTag } from '../utils/bcp47';
import { ProcessManager, ExecutableResolution } from '../utils/process-manager';

export class WindowsAiProvider implements ITranslationProvider {
  private ipcClient: JsonLinesIpcClient | null = null;
  private cachedPairs: LanguagePair[] | null = null;
  private readonly isWindows: boolean;
  private readonly resolution: ExecutableResolution;

  constructor() {
    this.isWindows = typeof process !== 'undefined' && process.platform === 'win32';
    this.resolution = ProcessManager.resolveWindowsExecutable();
  }

  public getInfo(): ProviderInfo {
    let unavailabilityReason = undefined;
    if (!this.isWindows) {
      unavailabilityReason = 'Edge Translator API is only available on Windows 10/11 with Microsoft Edge (Chromium).';
    } else if (!this.resolution.exists) {
      unavailabilityReason = this.resolution.error;
    }

    return {
      id: 'edge-translator',
      name: 'Edge Translator API',
      version: '1.0.0 (Edge/Chromium Native)',
      platform: ['win32'],
      description: 'Zero-cloud, privacy-first translation using the built-in Edge Translator API with on-device neural models.',
      minOSVersion: 'Windows 10/11 with Edge 148+',
      requiresNPU: false,
      isAvailable: this.isWindows && this.resolution.exists,
      unavailabilityReason: unavailabilityReason,
      isStandaloneRuntime: true,
      runtimePath: this.resolution.path,
    };
  }

  public async isAvailable(): Promise<boolean> {
    if (!this.isWindows || !this.resolution.exists) {
      return false;
    }

    try {
      const client = this.getIpcClient();
      const res = await client.sendRequest('ping', {}, 5000);
      return res?.status === 'ok';
    } catch {
      return false;
    }
  }

  public async getSupportedLanguages(): Promise<LanguagePair[]> {
    if (this.cachedPairs) {
      return this.cachedPairs;
    }

    // Chrome/Edge Translator API supported languages
    const supportedLanguages = [
      'ar', 'bg', 'bn', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he',
      'hi', 'hr', 'hu', 'id', 'it', 'ja', 'kn', 'ko', 'lt', 'mr', 'nl', 'no',
      'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'ta', 'te', 'th', 'tr', 'uk',
      'vi', 'zh', 'zh-Hant'
    ];

    const pairs: LanguagePair[] = [];
    for (const src of supportedLanguages) {
      for (const tgt of supportedLanguages) {
        if (src !== tgt) {
          pairs.push({
            source: src,
            target: tgt,
            installed: true,
            providerId: 'edge-translator',
          });
        }
      }
    }

    this.cachedPairs = pairs;
    return pairs;
  }

  public async detectLanguage(text: string): Promise<LanguageDetectionResult> {
    if (!this.isWindows) {
      return { language: 'en', confidence: 0.5, isReliable: false };
    }

    try {
      const client = this.getIpcClient();
      const res = await client.sendRequest<LanguageDetectionResult>('detect', { text }, 10000);
      return {
        language: normalizeLanguageTag(res.language),
        confidence: res.confidence,
        isReliable: res.isReliable,
      };
    } catch {
      return { language: 'en', confidence: 0.5, isReliable: false };
    }
  }

  public async canTranslate(sourceLang: string, targetLang: string): Promise<boolean> {
    if (!this.isWindows) return false;
    const src = normalizeLanguageTag(sourceLang);
    const tgt = normalizeLanguageTag(targetLang);
    if (src === tgt) return true;

    const pairs = await this.getSupportedLanguages();
    return pairs.some((p) => p.source === src && p.target === tgt);
  }

  public async translate(request: TranslationRequest): Promise<TranslationResult> {
    const start = Date.now();
    const src = request.sourceLang === 'auto' ? 'auto' : normalizeLanguageTag(request.sourceLang);
    const tgt = normalizeLanguageTag(request.targetLang);

    if (!this.isWindows) {
      throw new Error('Edge Translator provider is not available on this platform.');
    }

    const client = this.getIpcClient();
    const res = await client.sendRequest<any>(
      'translate',
      {
        text: request.text,
        sourceLang: src,
        targetLang: tgt,
      },
      request.timeoutMs || 30000
    );

    return {
      id: request.id,
      translatedText: res.translatedText,
      detectedSourceLang: res.detectedSourceLang || src,
      targetLang: tgt,
      providerUsed: 'edge-translator',
      providerName: 'Edge Translator API',
      fromCache: false,
      durationMs: Date.now() - start,
    };
  }

  public cancel(requestId: string): void {
    if (this.ipcClient) {
      this.ipcClient.cancel(requestId);
    }
  }

  public dispose(): void {
    if (this.ipcClient) {
      this.ipcClient.dispose();
      this.ipcClient = null;
    }
  }

  private getIpcClient(): JsonLinesIpcClient {
    this.ipcClient ??= new JsonLinesIpcClient(
      () => {
        return ProcessManager.spawnWorker(this.resolution.path, [], {}, this.resolution.isNodeScript || false);
      },
      30000,
      'EdgeTranslatorHelper'
    );
    return this.ipcClient;
  }
}
