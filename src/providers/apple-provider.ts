/**
 * Apple Translation Framework Provider (macOS 15+)
 * 
 * Uses bundled standalone native Swift binary or compiles helper.
 */

import { ITranslationProvider } from './provider-interface';
import {
  LanguageDetectionResult,
  LanguagePair,
  ProviderInfo,
  TranslationRequest,
  TranslationResult,
} from '../types';
import { JsonLinesIpcClient } from '../ipc-helper';
import { normalizeLanguageTag } from '../bcp47';
import { ProcessManager, ExecutableResolution } from '../process-manager';

export class AppleTranslationProvider implements ITranslationProvider {
  private ipcClient: JsonLinesIpcClient | null = null;
  private cachedPairs: LanguagePair[] | null = null;
  private isMacOS: boolean;
  private resolution: ExecutableResolution;

  constructor() {
    this.isMacOS = typeof process !== 'undefined' && process.platform === 'darwin';
    this.resolution = ProcessManager.resolveAppleExecutable();
  }

  public getInfo(): ProviderInfo {
    return {
      id: 'apple',
      name: 'Apple Translation Framework',
      version: '1.0.0 (macOS 15+ Native)',
      platform: ['darwin'],
      description: 'Zero-cloud, privacy-first translation using native Apple Silicon / CoreML neural models.',
      minOSVersion: 'macOS 15.0 Sequoia',
      requiresNPU: false,
      isAvailable: this.isMacOS && this.resolution.exists,
      unavailabilityReason: !this.isMacOS
        ? 'Apple Translation Framework is only available on macOS 15.0 or later.'
        : !this.resolution.exists
        ? this.resolution.error
        : undefined,
      isStandaloneRuntime: true,
      runtimePath: this.resolution.path,
    };
  }

  public async isAvailable(): Promise<boolean> {
    if (!this.isMacOS || !this.resolution.exists) {
      return false;
    }

    try {
      const client = this.getIpcClient();
      const res = await client.sendRequest('ping', {}, 2000);
      return res && res.status === 'ok';
    } catch {
      return false;
    }
  }

  public async getSupportedLanguages(): Promise<LanguagePair[]> {
    if (this.cachedPairs) {
      return this.cachedPairs;
    }

    const commonLanguages = ['en', 'it', 'es', 'de', 'fr', 'pt', 'ru', 'ja', 'ko', 'zh', 'nl', 'pl', 'uk', 'ar', 'tr'];
    const pairs: LanguagePair[] = [];

    for (const src of commonLanguages) {
      for (const tgt of commonLanguages) {
        if (src !== tgt) {
          pairs.push({
            source: src,
            target: tgt,
            installed: true,
            providerId: 'apple',
          });
        }
      }
    }

    this.cachedPairs = pairs;
    return pairs;
  }

  public async detectLanguage(text: string): Promise<LanguageDetectionResult> {
    if (!this.isMacOS) {
      return { language: 'en', confidence: 0.5, isReliable: false };
    }

    try {
      const client = this.getIpcClient();
      const res = await client.sendRequest<LanguageDetectionResult>('detect', { text }, 3000);
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
    if (!this.isMacOS) return false;
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

    if (!this.isMacOS) {
      throw new Error('Apple Translation provider is not available on this platform.');
    }

    const client = this.getIpcClient();
    const res = await client.sendRequest<any>(
      'translate',
      {
        text: request.text,
        sourceLang: src,
        targetLang: tgt,
      },
      request.timeoutMs || 15000
    );

    return {
      id: request.id,
      translatedText: res.translatedText,
      detectedSourceLang: res.detectedSourceLang || src,
      targetLang: tgt,
      providerUsed: 'apple',
      providerName: 'Apple Translation Framework',
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
    if (!this.ipcClient) {
      this.ipcClient = new JsonLinesIpcClient(
        () => {
          return ProcessManager.spawnWorker(this.resolution.path);
        },
        15000,
        'AppleTranslationHelper'
      );
    }
    return this.ipcClient;
  }
}
