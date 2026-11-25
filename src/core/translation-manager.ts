/**
 * Mailspring Offline Translation Manager
 * 
 * Orchestrator handling:
 * - Operating-system aware provider resolution priority (macOS: Apple -> Mozilla/Translations; Windows: Windows AI -> Mozilla/Translations; Linux: Mozilla/Translations)
 * - Automatic provider selection and fallback in platform priority order
 * - In-flight duplicate request deduplication
 * - SHA-256 local translation caching
 * - HTML structure preservation
 * - ProcessManager lifecycle supervision
 * - Cancellation and timeouts
 */

import { ITranslationProvider } from '../providers/provider-interface';
import { AppleTranslationProvider } from '../providers/apple-provider';
import { WindowsAiProvider } from '../providers/windows-provider';
import { BergamotTranslationProvider } from '../providers/bergamot-provider';
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

declare const AppEnv: any;
const CONFIG_KEY = 'mailspring-offline-translator.settings';

export class TranslationManager {
  private readonly providers: Map<ProviderId, ITranslationProvider> = new Map();
  private readonly cache: TranslationCache;
  private settings: PluginSettings;
  private readonly inFlightRequests: Map<string, Promise<TranslationResult>> = new Map();
  private readonly platform: SupportedPlatform;
  private configSubscription: { dispose: () => void } | null = null;

  constructor(
    customSettings?: Partial<PluginSettings>,
    customProviders?: Map<ProviderId, ITranslationProvider>
  ) {
    this.platform = (typeof process !== 'undefined' && (process.platform as SupportedPlatform)) || 'linux';

    const persistedSettings = this.loadFromAppEnv();

    this.settings = {
      defaultTargetLanguage: 'system',
      preferredProvider: 'auto',
      autoDetectSource: true,
      displayMode: 'split',
      excludeSignatures: true,
      excludeQuotedReplies: true,
      excludeCodeBlocks: true,
      cacheEnabled: true,
      cacheTTLHours: 720,
      maxCacheSizeMB: 50,
      appleHelperPath: 'helpers/apple/bin/apple-translator-darwin-universal',
      ...persistedSettings,
      ...customSettings,
    };

    if (AppEnv !== undefined && AppEnv.config?.onDidChange) {
      this.configSubscription = AppEnv.config.onDidChange(CONFIG_KEY, ({ newValue }: { newValue?: Partial<PluginSettings> }) => {
        if (newValue) {
          this.settings = { ...this.settings, ...newValue };
        }
      });
    }

    this.cache = new TranslationCache(this.settings.maxCacheSizeMB, this.settings.cacheTTLHours);

    if (customProviders) {
      this.providers = customProviders;
    } else {
      this.initDefaultProviders();
    }
  }

  private initDefaultProviders(): void {
    this.providers.set('apple', new AppleTranslationProvider());
    this.providers.set('edge-translator', new WindowsAiProvider());
    this.providers.set('bergamot', new BergamotTranslationProvider());
  }

  private loadFromAppEnv(): Partial<PluginSettings> {
    if (AppEnv !== 'undefined' && AppEnv.config?.get) {
      return AppEnv.config.get(CONFIG_KEY) || {};
    }
    return {};
  }

  /**
   * Updates configuration settings.
   */
  public updateSettings(newSettings: Partial<PluginSettings>): void {
    this.settings = { ...this.settings, ...newSettings };
    if (AppEnv !== 'undefined' && AppEnv.config?.set) {
      AppEnv.config.set(CONFIG_KEY, this.settings);
    }
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

  // -----------------------------------------------------------------------
  // Mozilla/Translations model management
  // -----------------------------------------------------------------------

  public async getInstalledBergamotModels(): Promise<LanguagePair[]> {
    const bergamot = this.providers.get('bergamot');
    if (!bergamot) {
      throw new Error('Mozilla/Translations provider is not registered.');
    }
    return bergamot.getSupportedLanguages();
  }

  public async getInstallableBergamotModels(): Promise<ModelPackage[]> {
    const bergamot = this.providers.get('bergamot');
    if (!bergamot?.listInstallableModels) {
      throw new Error('Mozilla/Translations model catalog is not available.');
    }
    return bergamot.listInstallableModels();
  }

  public async installBergamotModel(
    fromLang: string,
    toLang: string,
    onProgress?: (percent: number, message: string) => void
  ): Promise<boolean> {
    const bergamot = this.providers.get('bergamot');
    if (!bergamot?.installModel) {
      throw new Error('Mozilla/Translations model installation is not supported by this provider.');
    }
    return bergamot.installModel(fromLang, toLang, onProgress);
  }

  public async removeBergamotModel(fromLang: string, toLang: string): Promise<boolean> {
    const bergamot = this.providers.get('bergamot');
    if (!bergamot?.removeModel) {
      throw new Error('Mozilla/Translations model removal is not supported by this provider.');
    }
    return bergamot.removeModel(fromLang, toLang);
  }

  /**
   * Determines provider priority list based on host OS.
   */
  public getPriorityList(): ProviderId[] {
    if (this.platform === 'darwin') {
      return ['apple', 'bergamot'];
    }
    if (this.platform === 'win32') {
      return ['edge-translator', 'bergamot'];
    }
    return ['bergamot'];
  }

  /**
   * Checks whether the Mozilla/Translations model for the given language pair is installed.
   * If not installed, it automatically downloads it.
   * 
   * @param sourceLang Normalized source language
   * @param targetLang Normalized target language
   * @param onProgress Optional callback for download progress
   * @returns true if the model was already installed or successfully downloaded, false otherwise
   */
  public async ensureBergamotModel(
    sourceLang: string,
    targetLang: string,
    onProgress?: (percent: number, message: string) => void
  ): Promise<boolean> {
    const pair = `${sourceLang}-${targetLang}`;
    const bergamot = this.providers.get('bergamot');
    if (!bergamot) {
      return false;
    }

    // Check if the model is already installed
    const isInstalled = await bergamot.canTranslate(sourceLang, targetLang);
    if (isInstalled) {
      return true;
    }

    // Model not installed, try to download it
    if (bergamot.installModel) {
      try {
        if (onProgress) {
          onProgress(0, `Downloading Mozilla/Translations model ${pair}...`);
        }
        const success = await bergamot.installModel(sourceLang, targetLang, onProgress);
        if (success) {
          if (onProgress) {
            onProgress(100, `Model ${pair} installed successfully.`);
          }
          return true;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (onProgress) {
          onProgress(0, `Error downloading model ${pair}: ${msg}`);
        }
        return false;
      }
    }

    return false;
  }

  /**
   * Asynchronously determines whether automatic Mozilla/Translations model download should be performed.
   *
   * Mozilla/Translations should only be downloaded as a last resort when no other provider
   * (Apple, Edge) is available and can translate the language pair.
   * 
   * 3 cases:
   * 1. Mozilla/Translations provider explicitly selected → always download
   * 2. Non-Mozilla/Translations provider explicitly selected (e.g. Apple, Edge) → never download Mozilla/Translations
   * 3. Auto provider mode → download Mozilla/Translations only if no non-Mozilla/Translations provider can translate
   * 
   * @param sourceLang Normalized source language
   * @param targetLang Normalized target language
   * @returns true if automatic download should be performed
   */
  private async shouldAutoDownloadBergamot(sourceLang: string, targetLang: string): Promise<boolean> {
    const preferred = this.settings.preferredProvider;

    // Case 1: Mozilla/Translations provider explicitly selected → always download
    if (preferred === 'bergamot') {
      return true;
    }

    // Case 2: user explicitly selected a non-Mozilla/Translations provider (e.g. Apple, Edge)
    // → never auto-download Mozilla/Translations, respect the user's choice
    if (preferred !== 'auto') {
      return false;
    }

    // Case 3: auto provider mode
    // Only download Mozilla/Translations if no non-Mozilla/Translations provider is available and can translate
    const priority = this.getPriorityList();

    // Check if any non-Mozilla/Translations provider can handle this translation
    for (const pid of priority) {
      if (pid === 'bergamot') continue; // Skip Mozilla/Translations — we're checking if we NEED it
      const p = this.providers.get(pid);
      if (!p) continue;

      // If a non-Mozilla/Translations provider is available and can translate, don't download Mozilla/Translations
      const avail = await p.isAvailable();
      if (avail) {
        const can = await p.canTranslate(sourceLang, targetLang);
        if (can) {
          // A non-Mozilla/Translations provider can handle this — no need to download Mozilla/Translations
          return false;
        }
      }
    }

    // No non-Mozilla/Translations provider can translate — Mozilla/Translations is the last resort
    return priority.includes('bergamot');
  }

  /**
   * Resolves the explicitly selected provider or tries providers in platform priority order in automatic mode.
   */
  public async resolveProvider(
    sourceLang: string,
    targetLang: string
  ): Promise<ITranslationProvider | null> {
    const preferred = this.settings.preferredProvider;

    /** Helper: try a single provider */
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
      return tryProvider(preferred);
    }

    // 'auto' mode: use the platform priority list
    const priority = this.getPriorityList();
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
    let provider = await this.resolveProvider(sourceLang, targetLang);

    // If no provider is available and auto-download is enabled,
    // try to download the Mozilla/Translations model and re-resolve the provider
    if (!provider && await this.shouldAutoDownloadBergamot(sourceLang, targetLang)) {
      const bergamot = this.providers.get('bergamot');
      if (bergamot) {
        const pair = `${sourceLang}-${targetLang}`;
        try {
          const downloaded = await this.ensureBergamotModel(sourceLang, targetLang, request.onProgress);
          if (downloaded) {
            provider = await this.resolveProvider(sourceLang, targetLang);
            if (!provider) {
              throw new Error(
                `Bergamot model ${pair} downloaded but no provider is available for ${sourceLang} -> ${targetLang}.`
              );
            }
          } else {
            throw new Error(
              `Unable to download Bergamot model for ${pair}. ` +
              `Check your internet connection or install the model manually from preferences.`
            );
          }
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          throw new Error(
            `No offline translation provider available for ${sourceLang} -> ${targetLang}. ${msg}`
          );
        }
      }
    }

    if (!provider) {
      throw new Error(
        `No offline translation provider is available for ${sourceLang} -> ${targetLang}. Ensure a supported offline provider and language models are installed.`
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
      if (this.settings.preferredProvider === 'auto') {
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
    if (this.configSubscription) {
      this.configSubscription.dispose();
      this.configSubscription = null;
    }
    for (const provider of this.providers.values()) {
      provider.dispose();
    }
    this.inFlightRequests.clear();
    ProcessManager.terminateAll();
  }
}
