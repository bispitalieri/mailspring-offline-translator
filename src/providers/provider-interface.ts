/**
 * Unified Translation Provider Interface
 */

import {
  LanguageDetectionResult,
  LanguagePair,
  ModelPackage,
  ProviderInfo,
  TranslationRequest,
  TranslationResult,
} from '../types';

export interface ITranslationProvider {
  getInfo(): ProviderInfo;
  isAvailable(): Promise<boolean>;
  getSupportedLanguages(): Promise<LanguagePair[]>;
  detectLanguage(text: string): Promise<LanguageDetectionResult>;
  canTranslate(sourceLang: string, targetLang: string): Promise<boolean>;
  translate(request: TranslationRequest): Promise<TranslationResult>;
  cancel(requestId: string): void;
  dispose(): void;
  listInstallableModels?(): Promise<ModelPackage[]>;
  installModel?(
    fromLang: string,
    toLang: string,
    onProgress?: (percent: number, message: string) => void
  ): Promise<boolean>;
  removeModel?(fromLang: string, toLang: string): Promise<boolean>;
}
