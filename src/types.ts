/**
 * Mailspring Offline Translator - TypeScript Type Definitions
 */

export type SupportedPlatform = 'darwin' | 'win32' | 'linux';

export type ProviderId = 'apple' | 'windows-ai' | 'argos' | 'auto';

export interface ProviderInfo {
  id: ProviderId;
  name: string;
  version: string;
  platform: SupportedPlatform[];
  description: string;
  requiresNPU?: boolean;
  minOSVersion?: string;
  isAvailable: boolean;
  unavailabilityReason?: string;
  isStandaloneRuntime?: boolean;
  runtimePath?: string;
}

export interface LanguagePair {
  source: string; // ISO 639-1 or BCP-47
  target: string;
  sourceName?: string;
  targetName?: string;
  installed: boolean;
  modelSizeMB?: number;
  providerId: ProviderId;
}

export interface TranslationRequest {
  id: string;
  text: string;
  sourceLang: string; // 'auto' or 2-letter code
  targetLang: string; // 2-letter code
  isHtml?: boolean;
  providerId?: ProviderId;
  timeoutMs?: number;
}

export interface TranslationResult {
  id: string;
  translatedText: string;
  detectedSourceLang?: string;
  targetLang: string;
  providerUsed: ProviderId;
  providerName: string;
  fromCache: boolean;
  durationMs: number;
}

export interface LanguageDetectionResult {
  language: string;
  confidence: number;
  isReliable: boolean;
}

export interface ModelPackage {
  fromCode: string;
  fromName: string;
  toCode: string;
  toName: string;
  packageVersion: string;
  sizeMB: number;
  isInstalled: boolean;
  downloadUrl?: string;
  provider: ProviderId;
}

export interface PluginSettings {
  defaultTargetLanguage: string; // 'system' or BCP-47 code
  preferredProvider: ProviderId;
  autoFallback: boolean;
  autoDetectSource: boolean;
  displayMode: 'inline' | 'split' | 'toggle';
  excludeSignatures: boolean;
  excludeQuotedReplies: boolean;
  excludeCodeBlocks: boolean;
  cacheEnabled: boolean;
  cacheTTLHours: number; // e.g. 720 (30 days)
  maxCacheSizeMB: number;
  modelsDirectory?: string;
  appleHelperPath?: string;
}

export interface CacheEntry {
  hash: string;
  sourceLang: string;
  targetLang: string;
  providerId: string;
  translatedText: string;
  createdAt: number;
  lastAccessedAt: number;
  sizeBytes: number;
}

export interface CacheStats {
  entryCount: number;
  totalSizeBytes: number;
  hitCount: number;
  missCount: number;
}

export interface IPCMessage<T = unknown> {
  id: string;
  action: 'detect' | 'translate' | 'list_models' | 'list_installed' | 'list_available' | 'install_model' | 'remove_model' | 'ping' | string;
  payload?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}
