/**
 * Mailspring Offline Translation Manager
 * 
 * Orchestrator handling:
 * - Operating-system aware provider resolution priority (macOS: Apple -> Argos; Windows: Windows AI -> Argos; Linux: Argos)
 * - Automatic graceful fallback on provider failure or missing language pairs
 * - In-flight duplicate request deduplication
 * - SHA-256 local translation caching
 * - HTML structure preservation
 * - ProcessManager lifecycle supervision
 * - Cancellation and timeouts
 */

import { ITranslationProvider } from './providers/provider-interface';
import { AppleTranslationProvider } from './providers/apple-provider';
import { WindowsAiProvider } from './providers/windows-provider';
import { ArgosTranslationProvider } from './providers/argos-provider';
import {
  LanguageDetectionResult,
  LanguagePair,
  ModelPackage,
  PluginSettings,
  ProviderId,
  ProviderInfo,
  SupportedPlatform,
  TranslationRequest,
  TranslationResult,
} from './types';
import { TranslationCache } from './cache';
import { HtmlTranslator } from './html-translator';
import { getSystemLocale, normalizeLanguageTag } from './bcp47';
import { ProcessManager } from './process-manager';

export class TranslationManager {
  private providers: Map<ProviderId, ITranslationProvider> = new Map();
  private cache: TranslationCache;
  private settings: PluginSettings;
  private inFlightRequests: Map<string, Promise<TranslationResult>> = new Map();
  private platform: SupportedPlatform;

  constructor(
    customSettings?: Partial<PluginSettings>,
    customProviders?: Map<ProviderId, ITranslationProvider>
  ) {
    this.platform = (typeof process !== 'undefined' && (process.platform as SupportedPlatform)) || 'linux';

    this.settings = {
      defaultTargetLanguage: 'system',
      preferredProvider: 'auto',
      autoFallback: true,
      autoDetectSource: true,
      displayMode: 'split',
      excludeSignatures: true,
      excludeQuotedReplies: true,
      excludeCodeBlocks: true,
      cacheEnabled: true,
      cacheTTLHours: 720,
      maxCacheSizeMB: 50,
      appleHelperPath: 'helpers/apple/bin/apple-translator-darwin-universal',
      ...customSettings,
    };

    this.cache = new TranslationCache(this.settings.maxCacheSizeMB, this.settings.cacheTTLHours);

    if (customProviders) {
      this.providers = customProviders;
    } else {
      this.initDefaultProviders();
    }
  }

  private initDefaultProviders(): void {
    this.providers.set('apple', new AppleTranslationProvider());
    this.providers.set('windows-ai', new WindowsAiProvider());
    this.providers.set('argos', new ArgosTranslationProvider());
  }

  /**
   * Updates configuration settings.
   */
  public updateSettings(newSettings: Partial<PluginSettings>): void {
    this.settings = { ...this.settings, ...newSettings };
  }

  public getSettings(): PluginSettings {
    return { ...this.settings };
  }

  public getCache(): TranslationCache {
    return this.cache;
  }

  /**
   * Returns list of all registered providers and their diagnostic metadata.
   */
  public getProvidersInfo(): ProviderInfo[] {
    return Array.from(this.providers.values()).map((p) => p.getInfo());
  }

  public async getProviderDiagnostics(): Promise<ProviderInfo[]> {
    await Promise.all(
      Array.from(this.providers.values()).map((provider) =>
        provider.isAvailable().catch(() => false)
      )
    );
    return this.getProvidersInfo();
  }

  public async getInstalledArgosModels(): Promise<LanguagePair[]> {
    const argos = this.providers.get('argos');
    if (!argos) {
      throw new Error('Argos provider is not registered.');
    }
    return argos.getSupportedLanguages();
  }

  public async getInstallableArgosModels(): Promise<ModelPackage[]> {
    const argos = this.providers.get('argos');
    if (!argos?.listInstallableModels) {
      throw new Error('Argos model catalog is not available.');
    }
    return argos.listInstallableModels();
  }

  public async installArgosModel(
    fromLang: string,
    toLang: string,
    onProgress?: (percent: number, message: string) => void
  ): Promise<boolean> {
    const argos = this.providers.get('argos');
    if (!argos?.installModel) {
      throw new Error('Argos model installation is not supported by this provider.');
    }
    return argos.installModel(fromLang, toLang, onProgress);
  }

  public async removeArgosModel(fromLang: string, toLang: string): Promise<boolean> {
    const argos = this.providers.get('argos');
    if (!argos?.removeModel) {
      throw new Error('Argos model removal is not supported by this provider.');
    }
    return argos.removeModel(fromLang, toLang);
  }

  /**
   * Determines provider priority list based on host OS.
   */
  public getPriorityList(): ProviderId[] {
    if (this.platform === 'darwin') {
      return ['apple', 'argos'];
    }
    if (this.platform === 'win32') {
      return ['windows-ai', 'argos'];
    }
    return ['argos'];
  }

  /**
   * Resolves the primary provider to use, honoring preferredProvider or automatic platform priority.
   */
  public async resolveProvider(
    sourceLang: string,
    targetLang: string
  ): Promise<ITranslationProvider | null> {
    const preferred = this.settings.preferredProvider;

    // Manual provider selection
    if (preferred !== 'auto') {
      const provider = this.providers.get(preferred);
      if (provider) {
        const avail = await provider.isAvailable();
        const canTrans = await provider.canTranslate(sourceLang, targetLang);
        if (avail && canTrans) {
          return provider;
        }
      }
      // If manual selection fails and fallback is disabled, return null
      if (!this.settings.autoFallback) {
        return null;
      }
    }

    // Automatic platform priority resolution
    const priority = this.getPriorityList();
    for (const pid of priority) {
      const p = this.providers.get(pid);
      if (!p) continue;

      const avail = await p.isAvailable();
      if (!avail) continue;

      const can = await p.canTranslate(sourceLang, targetLang);
      if (can) {
        return p;
      }
    }

    // Fallback: Check if Argos is available even if pair check was strict
    const argos = this.providers.get('argos');
    if (argos && (await argos.isAvailable())) {
      return argos;
    }

    return null;
  }

  /**
   * Resolves the effective target language, converting 'system' to normalized BCP-47.
   */
  public getEffectiveTargetLanguage(): string {
    if (this.settings.defaultTargetLanguage === 'system' || !this.settings.defaultTargetLanguage) {
      return getSystemLocale();
    }
    return normalizeLanguageTag(this.settings.defaultTargetLanguage);
  }

  /**
   * Identifies the language of the source text using the highest-priority available provider.
   */
  public async detectLanguage(text: string): Promise<LanguageDetectionResult> {
    const priority = this.getPriorityList();
    for (const pid of priority) {
      const p = this.providers.get(pid);
      if (p && (await p.isAvailable())) {
        try {
          const res = await p.detectLanguage(text);
          if (res && res.language) {
            return res;
          }
        } catch {
          // Continue to next provider
        }
      }
    }
    return { language: 'en', confidence: 0.5, isReliable: false };
  }

  /**
   * Translates incoming or outgoing text/HTML with caching, deduplication, and fallback.
   */
  public async translate(request: TranslationRequest): Promise<TranslationResult> {
    const targetLang = request.targetLang || this.getEffectiveTargetLanguage();
    let sourceLang = request.sourceLang || 'auto';

    // Auto-detect source if needed
    if (sourceLang === 'auto') {
      const detected = await this.detectLanguage(request.text);
      sourceLang = detected.language;
    }

    sourceLang = normalizeLanguageTag(sourceLang);
    const normTarget = normalizeLanguageTag(targetLang);

    // If source and target are the same language, return immediately
    if (sourceLang === normTarget) {
      return {
        id: request.id,
        translatedText: request.text,
        detectedSourceLang: sourceLang,
        targetLang: normTarget,
        providerUsed: 'auto',
        providerName: 'Identical Language',
        fromCache: false,
        durationMs: 0,
      };
    }

    // Check cache
    const cacheKey = this.cache.generateKey(
      request.text,
      sourceLang,
      normTarget,
      request.providerId || this.settings.preferredProvider
    );

    if (this.settings.cacheEnabled) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return {
          id: request.id,
          translatedText: cached.translatedText,
          detectedSourceLang: cached.sourceLang,
          targetLang: cached.targetLang,
          providerUsed: cached.providerId as ProviderId,
          providerName: `${cached.providerId.toUpperCase()} (Cached)`,
          fromCache: true,
          durationMs: 0,
        };
      }
    }

    // In-flight deduplication: prevent parallel duplicate executions
    if (this.inFlightRequests.has(cacheKey)) {
      return this.inFlightRequests.get(cacheKey)!;
    }

    const executionPromise = this.executeTranslation(request, sourceLang, normTarget, cacheKey);
    this.inFlightRequests.set(cacheKey, executionPromise);

    try {
      const result = await executionPromise;
      return result;
    } finally {
      this.inFlightRequests.delete(cacheKey);
    }
  }

  private async executeTranslation(
    request: TranslationRequest,
    sourceLang: string,
    targetLang: string,
    cacheKey: string
  ): Promise<TranslationResult> {
    const provider = await this.resolveProvider(sourceLang, targetLang);
    if (!provider) {
      const argosInfo = this.providers.get('argos')?.getInfo();
      const detail = argosInfo?.unavailabilityReason;
      throw new Error(
        `No offline translation provider is available for ${sourceLang} -> ${targetLang}. ${
          detail || 'Ensure a supported offline provider and language models are installed.'
        }`
      );
    }

    const providerInfo = provider.getInfo();

    // Check if HTML processing is needed
    if (request.isHtml) {
      const translatedHtml = await HtmlTranslator.translateHtml(
        request.text,
        async (segments) => {
          const batchResults: string[] = [];
          for (const seg of segments) {
            const segResult = await provider.translate({
              id: `${request.id}_seg`,
              text: seg,
              sourceLang,
              targetLang,
              timeoutMs: request.timeoutMs,
            });
            batchResults.push(segResult.translatedText);
          }
          return batchResults;
        },
        {
          excludeSignatures: this.settings.excludeSignatures,
          excludeQuotedReplies: this.settings.excludeQuotedReplies,
          excludeCodeBlocks: this.settings.excludeCodeBlocks,
        }
      );

      const result: TranslationResult = {
        id: request.id,
        translatedText: translatedHtml,
        detectedSourceLang: sourceLang,
        targetLang,
        providerUsed: providerInfo.id,
        providerName: providerInfo.name,
        fromCache: false,
        durationMs: 0,
      };

      if (this.settings.cacheEnabled) {
        this.cache.set(cacheKey, result.translatedText, sourceLang, targetLang, providerInfo.id);
      }

      return result;
    }

    // Plain text translation
    try {
      const result = await provider.translate({
        ...request,
        sourceLang,
        targetLang,
      });

      if (this.settings.cacheEnabled) {
        this.cache.set(cacheKey, result.translatedText, sourceLang, targetLang, result.providerUsed);
      }

      return result;
    } catch (err: any) {
      if (this.settings.autoFallback) {
        const fallbacks = this.getPriorityList().filter((id) => id !== providerInfo.id);
        for (const fId of fallbacks) {
          const fallbackProvider = this.providers.get(fId);
          if (fallbackProvider && (await fallbackProvider.isAvailable())) {
            try {
              const fbResult = await fallbackProvider.translate({
                ...request,
                sourceLang,
                targetLang,
              });
              if (this.settings.cacheEnabled) {
                this.cache.set(cacheKey, fbResult.translatedText, sourceLang, targetLang, fbResult.providerUsed);
              }
              return fbResult;
            } catch {
              // Try next fallback
            }
          }
        }
      }
      throw err;
    }
  }

  public cancel(requestId: string): void {
    for (const provider of this.providers.values()) {
      provider.cancel(requestId);
    }
  }

  public dispose(): void {
    for (const provider of this.providers.values()) {
      provider.dispose();
    }
    this.inFlightRequests.clear();
    ProcessManager.terminateAll();
  }
}
