import test from 'node:test';
import assert from 'node:assert/strict';
import { TranslationManager } from '../lib/translation-manager';
import { ITranslationProvider } from '../lib/providers/provider-interface';
import { ArgosTranslationProvider } from '../lib/providers/argos-provider';
import { LanguageDetectionResult, LanguagePair, ProviderInfo, TranslationRequest, TranslationResult } from '../lib/types';

// Mock Provider for testing orchestrator fallback & resolution
class MockProvider implements ITranslationProvider {
  constructor(
    private id: any,
    private available: boolean,
    private supported: string[],
    private translateFn?: (text: string) => string
  ) {}

  getInfo(): ProviderInfo {
    return {
      id: this.id,
      name: `Mock ${this.id}`,
      version: '1.0',
      platform: ['darwin', 'win32', 'linux'],
      description: 'Mock',
      isAvailable: this.available,
    };
  }

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async getSupportedLanguages(): Promise<LanguagePair[]> {
    return this.supported.map((s) => ({
      source: 'en',
      target: s,
      installed: true,
      providerId: this.id,
    }));
  }

  async detectLanguage(text: string): Promise<LanguageDetectionResult> {
    return { language: 'en', confidence: 0.9, isReliable: true };
  }

  async canTranslate(sourceLang: string, targetLang: string): Promise<boolean> {
    return this.supported.includes(targetLang);
  }

  async translate(request: TranslationRequest): Promise<TranslationResult> {
    if (!this.available) throw new Error('Provider unavailable');
    const out = this.translateFn ? this.translateFn(request.text) : `[${this.id}] ${request.text}`;
    return {
      id: request.id,
      translatedText: out,
      detectedSourceLang: 'en',
      targetLang: request.targetLang,
      providerUsed: this.id,
      providerName: `Mock ${this.id}`,
      fromCache: false,
      durationMs: 5,
    };
  }

  cancel(requestId: string): void {}
  dispose(): void {}
}

test('TranslationManager prioritizes provider and falls back when unsupported', async () => {
  const mockApple = new MockProvider('apple', true, ['es']); // only supports es
  const mockArgos = new MockProvider('argos', true, ['es', 'it']); // supports it

  const customProviders = new Map();
  customProviders.set('apple', mockApple);
  customProviders.set('argos', mockArgos);

  const manager = new TranslationManager({ preferredProvider: 'auto', autoFallback: true }, customProviders);

  // Translating to 'it' (unsupported by Apple) should fallback to Argos
  const res = await manager.translate({
    id: 'req1',
    text: 'Hello friend',
    sourceLang: 'en',
    targetLang: 'it',
  });

  assert.equal(res.providerUsed, 'argos');
  assert.equal(res.targetLang, 'it');
});

test('TranslationManager returns identical text if source equals target', async () => {
  const manager = new TranslationManager();
  const res = await manager.translate({
    id: 'req2',
    text: 'Identical language test',
    sourceLang: 'en',
    targetLang: 'en',
  });

  assert.equal(res.translatedText, 'Identical language test');
  assert.equal(res.durationMs, 0);
});

test('TranslationManager deduplicates concurrent identical requests', async () => {
  let callCount = 0;
  const mockSlow = new MockProvider('argos', true, ['it'], (t) => {
    callCount++;
    return `Tradotto: ${t}`;
  });

  const customProviders = new Map();
  customProviders.set('argos', mockSlow);

  const manager = new TranslationManager({ cacheEnabled: false }, customProviders);

  // Fire two concurrent translations of identical text
  const [res1, res2] = await Promise.all([
    manager.translate({ id: 'a1', text: 'Concurrent text', sourceLang: 'en', targetLang: 'it' }),
    manager.translate({ id: 'a2', text: 'Concurrent text', sourceLang: 'en', targetLang: 'it' }),
  ]);

  assert.equal(res1.translatedText, 'Tradotto: Concurrent text');
  assert.equal(res2.translatedText, 'Tradotto: Concurrent text');
  // Both resolved, deduplicated to 1 underlying provider execution
  assert.equal(callCount, 1);
});

test('Argos reports when no native model is installed', async () => {
  const provider = new ArgosTranslationProvider('/path/that/does/not/exist');

  assert.equal(await provider.isAvailable(), false);
  assert.match(provider.getInfo().unavailabilityReason || '', /No Argos models are installed/);
  provider.dispose();
});
