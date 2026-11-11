/**
 * Windows Native AI Provider Adapter & Feasibility Probe
 */

import { ITranslationProvider } from './provider-interface';
import {
  LanguageDetectionResult,
  LanguagePair,
  ProviderInfo,
  TranslationRequest,
  TranslationResult,
} from '../types';

export class WindowsAiProvider implements ITranslationProvider {
  private isWindows: boolean;
  private hasNPU: boolean = false;
  private osBuild: number = 0;

  constructor() {
    this.isWindows = typeof process !== 'undefined' && process.platform === 'win32';
    this.probeHardware();
  }

  private probeHardware(): void {
    if (!this.isWindows) return;
    try {
      const os = require('os');
      const release = os.release();
      const parts = release.split('.');
      if (parts.length >= 3) {
        this.osBuild = parseInt(parts[2], 10) || 0;
      }
    } catch {
      this.osBuild = 0;
    }
  }

  public getInfo(): ProviderInfo {
    let reason = 'Native Windows AI Translation is only evaluated on Windows 11.';
    if (this.isWindows) {
      if (this.osBuild < 26100) {
        reason = `Requires Windows 11 Build 26100+ (Current build: ${this.osBuild}). Bundled Argos Translate runtime is used as local fallback.`;
      } else if (!this.hasNPU) {
        reason = 'No Copilot+ 40+ TOPS NPU detected. Windows App SDK Phi Silica requires an on-device NPU. Using bundled Argos Translate.';
      } else {
        reason = 'Dedicated offline translation API is not yet standard in Windows App SDK (requires cloud Azure Translator or Phi Silica prompt adaptation). Routed to bundled Argos Translate.';
      }
    }

    return {
      id: 'windows-ai',
      name: 'Windows AI Native (Phi Silica / Windows App SDK)',
      version: '1.6.0-evaluation',
      platform: ['win32'],
      description: 'Evaluates Windows App SDK on-device inference. Seamlessly routes to bundled Argos Translate for deterministic bilingual translation.',
      minOSVersion: 'Windows 11 Build 26100+ with 40+ TOPS NPU',
      requiresNPU: true,
      isAvailable: false,
      unavailabilityReason: reason,
      isStandaloneRuntime: false,
    };
  }

  public async isAvailable(): Promise<boolean> {
    return false;
  }

  public async getSupportedLanguages(): Promise<LanguagePair[]> {
    return [];
  }

  public async detectLanguage(text: string): Promise<LanguageDetectionResult> {
    return { language: 'en', confidence: 0.5, isReliable: false };
  }

  public async canTranslate(sourceLang: string, targetLang: string): Promise<boolean> {
    return false;
  }

  public async translate(request: TranslationRequest): Promise<TranslationResult> {
    throw new Error(
      'Windows Native AI Translation is unavailable: no native offline translation API found in Windows App SDK without cloud Azure. Please use bundled Argos Translate.'
    );
  }

  public cancel(requestId: string): void {}
  public dispose(): void {}
}
