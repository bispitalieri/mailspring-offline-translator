/**
 * Mailspring Message View Extension
 * 
 * Injects a non-destructive offline translation toolbar into Mailspring's message body header ('message:BodyHeader').
 * Allows instant translation of incoming emails, switching between Original, Inline, and Side-by-Side views,
 * displaying detected source language, and manual re-translation using alternative offline providers.
 * 
 * Crucial: Never mutates message body in Mailspring's SQLite/IndexedDB store.
 */

import React, { useState } from './react-runtime';
import { TranslationManager } from './translation-manager';
import { TranslationResult, ProviderId } from './types';
import { getLanguageDisplayName, getCommonLanguages } from './bcp47';
import {
  getMessageTranslationSource,
  sanitizeTranslatedHtml,
  setMessageTranslationPresentation,
} from './message-body-extension';

export interface MessageProps {
  message: {
    id: string;
    body: string;
    subject?: string;
    snippet?: string;
  };
}

export const MessageTranslatorHeader: React.FC<{
  message: any;
  manager?: TranslationManager;
  onTranslationChange?: (result: TranslationResult | null, mode: 'inline' | 'split' | 'original') => void;
}> = ({ message, manager: propsManager, onTranslationChange }) => {
  const manager = propsManager || (window as any).__mailspring_offline_translator_manager || new TranslationManager();

  const [isTranslating, setIsTranslating] = useState(false);
  const [translationResult, setTranslationResult] = useState<TranslationResult | null>(null);
  const [viewMode, setViewMode] = useState<'inline' | 'split' | 'original'>('original');
  const [targetLang, setTargetLang] = useState<string>(() => manager.getEffectiveTargetLanguage());
  const [detectedLang, setDetectedLang] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedProvider] = useState<ProviderId>('auto');

  const languages = getCommonLanguages();

  const handleTranslate = async (overrideTarget?: string, overrideProvider?: ProviderId) => {
    setIsTranslating(true);
    setError(null);
    try {
      const tgt = overrideTarget || targetLang;
      const prov = overrideProvider || selectedProvider;
      const source = getMessageTranslationSource(message);

      const res = await manager.translate({
        id: `msg_${message.id}_${Date.now()}`,
        text: source.body,
        sourceLang: 'auto',
        targetLang: tgt,
        isHtml: !source.isPlaintext,
        providerId: prov === 'auto' ? undefined : prov,
      });

      const visibleResult = source.isPlaintext
        ? res
        : { ...res, translatedText: await sanitizeTranslatedHtml(res.translatedText) };
      const defaultMode = manager.getSettings().displayMode === 'inline' ? 'inline' : 'split';
      await setMessageTranslationPresentation(message, visibleResult, defaultMode, source.isPlaintext);
      setTranslationResult(visibleResult);
      setDetectedLang(res.detectedSourceLang || null);
      setViewMode(defaultMode);
      onTranslationChange?.(visibleResult, defaultMode);
    } catch (err: any) {
      setError(err.message || 'Translation failed. Ensure offline language model is installed.');
    } finally {
      setIsTranslating(false);
    }
  };

  const handleViewModeToggle = async (mode: 'inline' | 'split' | 'original') => {
    setViewMode(mode);
    if (translationResult) {
      try {
        await setMessageTranslationPresentation(message, translationResult, mode);
        onTranslationChange?.(translationResult, mode);
        setError(null);
      } catch (err: any) {
        setError(err.message || 'Unable to update the displayed email body.');
      }
    }
  };

  return (
    <div className="offline-translator-header border-b border-neutral-700/50 bg-neutral-900/70 px-4 py-2.5 text-xs text-neutral-200">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center space-x-2">
          {/* Status or Translate Button */}
          {!translationResult ? (
            <button
              onClick={() => handleTranslate()}
              disabled={isTranslating}
              className="offline-translator-translate-btn"
              aria-label={isTranslating ? 'Translating message' : 'Translate message'}
            >
              {isTranslating ? (
                <>
                  <span className="offline-translator-translate-spinner" />
                  Translating...
                </>
              ) : (
                <>
                  <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor" aria-hidden="true">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
                  </svg>
                  Translate
                </>
              )}
            </button>
          ) : (
            <div className="flex items-center space-x-1.5">
              <span className="rounded bg-neutral-800 px-2 py-0.5 text-[11px] font-medium text-neutral-300">
                {detectedLang ? getLanguageDisplayName(detectedLang) : 'Detected'} → {getLanguageDisplayName(targetLang)}
              </span>
              <span className="rounded bg-emerald-950/80 px-1.5 py-0.5 text-[10px] text-emerald-400 border border-emerald-800/40">
                {translationResult.providerName}
              </span>
              {translationResult.fromCache && (
                <span className="rounded bg-cyan-950/80 px-1.5 py-0.5 text-[10px] text-cyan-400 border border-cyan-800/40">
                  Cached
                </span>
              )}
            </div>
          )}

          {/* Target language selector */}
          <div className="flex items-center space-x-1">
            <span className="text-neutral-400">To:</span>
            <select
              value={targetLang}
              onChange={(e) => {
                const nextLang = e.target.value;
                setTargetLang(nextLang);
                if (translationResult) {
                  handleTranslate(nextLang);
                }
              }}
              className="rounded border border-neutral-700 bg-neutral-800 px-2 py-0.5 text-xs text-neutral-100 focus:outline-none focus:ring-1 focus:ring-cyan-500"
            >
              {languages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name} ({l.code})
                </option>
              ))}
            </select>
          </div>
        </div>

        {/* View mode toggle */}
        {translationResult && (
          <div className="flex items-center space-x-2">
            <div className="inline-flex rounded-md bg-neutral-800 p-0.5 border border-neutral-700">
              <button
                onClick={() => handleViewModeToggle('original')}
                className={`rounded px-2 py-0.5 text-[11px] font-medium transition ${
                  viewMode === 'original' ? 'bg-neutral-700 text-white shadow' : 'text-neutral-400 hover:text-white'
                }`}
              >
                Original
              </button>
              <button
                onClick={() => handleViewModeToggle('inline')}
                className={`rounded px-2 py-0.5 text-[11px] font-medium transition ${
                  viewMode === 'inline' ? 'bg-neutral-700 text-white shadow' : 'text-neutral-400 hover:text-white'
                }`}
              >
                Translated
              </button>
              <button
                onClick={() => handleViewModeToggle('split')}
                className={`rounded px-2 py-0.5 text-[11px] font-medium transition ${
                  viewMode === 'split' ? 'bg-neutral-700 text-white shadow' : 'text-neutral-400 hover:text-white'
                }`}
              >
                Side-by-Side
              </button>
            </div>

            {/* Re-translate button */}
            <button
              onClick={() => handleTranslate()}
              disabled={isTranslating}
              title="Re-translate with chosen options"
              className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-white"
            >
              <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Error state */}
      {error && (
        <div className="mt-2 rounded bg-rose-950/70 p-2 text-[11px] text-rose-300 border border-rose-800/40">
          ⚠️ {error}
        </div>
      )}
    </div>
  );
};
