/**
 * Mailspring Message View Extension
 * 
 * Injects a non-destructive offline translation toolbar into Mailspring's message body header ('message:BodyHeader').
 * Allows instant translation of incoming emails, switching between Original, Inline, and Side-by-Side views,
 * displaying detected source language, and manual re-translation using alternative offline providers.
 * 
 * Crucial: Never mutates message body in Mailspring's SQLite/IndexedDB store.
 */

import React, { useState, useEffect } from '../utils/react-runtime';
import { TranslationManager } from '../core/translation-manager';
import { TranslationResult, ProviderId } from '../types';
import { getLanguageDisplayName, getCommonLanguages } from '../utils/bcp47';
import {
  getMessageTranslationSource,
  htmlToPlaintext,
  sanitizeTranslatedHtml,
  setMessageTranslationPresentation,
  resetMessageToOriginal,
  restoreCurrentMessageCache,
  clearMessageTranslationPresentation,
  currentMessageIdGetter,
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

  // Reset translation state when the selected message changes
  useEffect(() => {
    // Prima di passare alla nuova email, ripristiniamo la cache dell'email precedente
    // con il corpo originale e puliamo la presentation così quando l'utente torna indietro
    // vede il messaggio originale, non la traduzione riapplicata.
    (async () => {
      await restoreCurrentMessageCache();
      // Puliamo la presentation del messaggio precedente così non viene riapplicata
      // quando l'utente torna indietro.
      const prevId = currentMessageIdGetter();
      if (prevId) {
        clearMessageTranslationPresentation(prevId);
      }
      await resetMessageToOriginal(message);
    })();
    setViewMode('original');
    setTranslationResult(null);
    setDetectedLang(null);
    setError(null);
  }, [message.id]);

  const languages = getCommonLanguages();

  const handleTranslate = async (overrideTarget?: string, overrideProvider?: ProviderId) => {
    setIsTranslating(true);
    setError(null);
    try {
      const tgt = overrideTarget || targetLang;
      const source = getMessageTranslationSource(message);

      // Per i messaggi plaintext, convertiamo il corpo HTML in testo puro prima della traduzione
      // per evitare che i tag <br> e altri tag HTML vengano passati al modello di traduzione
      const textToTranslate = source.isPlaintext
        ? htmlToPlaintext(source.body)
        : source.body;

      const res = await manager.translate({
        id: `msg_${message.id}_${Date.now()}`,
        text: textToTranslate,
        sourceLang: 'auto',
        targetLang: tgt,
        isHtml: !source.isPlaintext,
        providerId: overrideProvider,
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
    <div className="offline-translator-header">
      <div className="offline-translator-header-row">
        <div className="offline-translator-header-left">
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
            <div className="offline-translator-status-badges">
              <span className="offline-translator-lang-badge">
                {detectedLang ? getLanguageDisplayName(detectedLang) : 'Detected'} → {getLanguageDisplayName(targetLang)}
              </span>
              <span className="offline-translator-provider-badge">
                {translationResult.providerName}
              </span>
            </div>
          )}

          {/* Target language selector */}
          <div className="offline-translator-lang-selector">
            <span className="offline-translator-lang-label">To:</span>
            <select
              value={targetLang}
              onChange={(e) => {
                const nextLang = e.target.value;
                setTargetLang(nextLang);
                if (translationResult) {
                  handleTranslate(nextLang);
                }
              }}
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
          <div className="offline-translator-header-right">
            <div className="offline-translator-view-toggle">
              <button
                onClick={() => handleViewModeToggle('original')}
                className={viewMode === 'original' ? 'active' : ''}
              >
                Original
              </button>
              <button
                onClick={() => handleViewModeToggle('inline')}
                className={viewMode === 'inline' ? 'active' : ''}
              >
                Translated
              </button>
              <button
                onClick={() => handleViewModeToggle('split')}
                className={viewMode === 'split' ? 'active' : ''}
              >
                Side-by-Side
              </button>
            </div>

            {/* Re-translate button */}
            <button
              onClick={() => handleTranslate()}
              disabled={isTranslating}
              title="Re-translate with chosen options"
              className="offline-translator-retranslate-btn"
            >
              <svg width="14" height="14" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Error state */}
      {error && (
        <div className="offline-translator-header-error">
          ⚠️ {error}
        </div>
      )}
    </div>
  );
};
