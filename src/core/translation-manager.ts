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

import { ITranslationProvider } from '../providers/provider-interface';
import { AppleTranslationProvider } from '../providers/apple-provider';
import { WindowsAiProvider } from '../providers/windows-provider';
import { OpusTranslationProvider } from '../providers/opus-provider';
import { ArgosTranslationProvider } from '../providers/argos-provider';
import { NllbTranslationProvider } from '../providers/nllb-provider';
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
} from '../types';
import { TranslationCache } from '../utils/cache';
import { HtmlTranslator } from '../utils/html-translator';
import { getSystemLocale, normalizeLanguageTag } from '../utils/bcp47';
import { ProcessManager } from '../utils/process-manager';

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
    this.providers.set('opus', new OpusTranslationProvider());
    this.providers.set('argos', new ArgosTranslationProvider());
    this.providers.set('nllb', new NllbTranslationProvider());
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

  public async getInstalledOpusModels(): Promise<LanguagePair[]> {
    const opus = this.providers.get('opus');
    if (!opus) {
      throw new Error('OPUS provider is not registered.');
    }
    return opus.getSupportedLanguages();
  }

  public async getInstallableOpusModels(): Promise<ModelPackage[]> {
    const opus = this.providers.get('opus');
    if (!opus?.listInstallableModels) {
      throw new Error('OPUS model catalog is not available.');
    }
    return opus.listInstallableModels();
  }

  public async installOpusModel(
    fromLang: string,
    toLang: string,
    onProgress?: (percent: number, message: string) => void
  ): Promise<boolean> {
    const opus = this.providers.get('opus');
    if (!opus?.installModel) {
      throw new Error('OPUS model installation is not supported by this provider.');
    }
    return opus.installModel(fromLang, toLang, onProgress);
  }

  public async removeOpusModel(fromLang: string, toLang: string): Promise<boolean> {
    const opus = this.providers.get('opus');
    if (!opus?.removeModel) {
      throw new Error('OPUS model removal is not supported by this provider.');
    }
    return opus.removeModel(fromLang, toLang);
  }

  // -----------------------------------------------------------------------
  // NLLB-200 model management
  // -----------------------------------------------------------------------

  public async getInstalledNllbModels(): Promise<LanguagePair[]> {
    const nllb = this.providers.get('nllb');
    if (!nllb) {
      throw new Error('NLLB provider is not registered.');
    }
    return nllb.getSupportedLanguages();
  }

  public async getInstallableNllbModels(): Promise<ModelPackage[]> {
    const nllb = this.providers.get('nllb');
    if (!nllb?.listInstallableModels) {
      throw new Error('NLLB model catalog is not available.');
    }
    return nllb.listInstallableModels();
  }

  public async installNllbModel(
    onProgress?: (percent: number, message: string) => void
  ): Promise<boolean> {
    const nllb = this.providers.get('nllb');
    if (!nllb?.installModel) {
      throw new Error('NLLB model installation is not supported by this provider.');
    }
    // NLLB is a single multilingual model, so fromLang/toLang are ignored
    return nllb.installModel('multilingual', 'multilingual', onProgress);
  }

  public async removeNllbModel(): Promise<boolean> {
    const nllb = this.providers.get('nllb');
    if (!nllb?.removeModel) {
      throw new Error('NLLB model removal is not supported by this provider.');
    }
    return nllb.removeModel('multilingual', 'multilingual');
  }

  /**
   * Determines provider priority list based on host OS.
   * OPUS-MT is inserted between the native provider and Argos as a higher-quality offline fallback.
   */
  public getPriorityList(): ProviderId[] {
    if (this.platform === 'darwin') {
      return ['apple', 'nllb', 'opus', 'argos'];
    }
    if (this.platform === 'win32') {
      return ['windows-ai', 'nllb', 'opus', 'argos'];
    }
    return ['nllb', 'opus', 'argos'];
  }

  /**
   * Resolves the primary provider to use, honoring preferredProvider or automatic platform priority.
   * 
   * Se preferredProvider non è 'auto':
   *   - Se autoFallback è true: prova il provider preferito, poi ricade sugli altri in ordine di priorità.
   *   - Se autoFallback è false: usa solo il provider preferito senza fallback.
   * Se preferredProvider è 'auto':
   *   - Se autoFallback è true: usa la lista di priorità della piattaforma provando tutti i provider.
   *   - Se autoFallback è false: usa solo il primo provider della lista di priorità.
   */
  public async resolveProvider(
    sourceLang: string,
    targetLang: string
  ): Promise<ITranslationProvider | null> {
    const preferred = this.settings.preferredProvider;
    const allowFallback = this.settings.autoFallback;

    /** Helper: prova un singolo provider */
    const tryProvider = async (pid: ProviderId): Promise<ITranslationProvider | null> => {
      const p = this.providers.get(pid);
      if (!p) return null;
      const avail = await p.isAvailable();
      if (!avail) return null;
      const can = await p.canTranslate(sourceLang, targetLang);
      if (can) return p;
      return null;
    };

    if (preferred !== 'auto') {
      // Provider specifico selezionato dall'utente
      const result = await tryProvider(preferred);
      if (result) return result;

      // Se il provider preferito non funziona e il fallback è abilitato, prova gli altri
      if (allowFallback) {
        const priority = this.getPriorityList();
        for (const pid of priority) {
          if (pid === preferred) continue; // Salta il provider già provato
          const result = await tryProvider(pid);
          if (result) return result;
        }
      }

      return null;
    }

    // Modalità 'auto': usa la lista di priorità della piattaforma
    const priority = this.getPriorityList();
    
    if (!allowFallback) {
      // Senza fallback, prova solo il primo provider della lista
      return await tryProvider(priority[0]);
    }

    // Con fallback abilitato, prova tutti i provider in ordine di priorità
    for (const pid of priority) {
      const result = await tryProvider(pid);
      if (result) return result;
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
