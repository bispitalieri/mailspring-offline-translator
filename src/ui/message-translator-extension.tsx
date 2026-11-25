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
import { TranslationManager } from '../core';
import { TranslationResult, ProviderId, ModelPackage } from '../types';
import { getLanguageDisplayName, getCommonLanguages, normalizeLanguageTag } from '../utils';
import { confirmationWindow } from './confirmation-window';
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
  const [sourceLang, setSourceLang] = useState<string>('auto');
  const [detectedLang, setDetectedLang] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ percent: number; message: string } | null>(null);

  // Reset translation state when the selected message changes
  useEffect(() => {
    // Before switching to the new email, restore the previous email's cache
    // with the original body and clear the presentation so when the user goes back
    // they see the original message, not the re-applied translation.
    (async () => {
      await restoreCurrentMessageCache();
      // Clear the previous message's presentation so it doesn't get re-applied
      // when the user goes back.
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

  const confirmModelDownloadIfNeeded = async (text: string, target: string): Promise<boolean> => {
    const settings = manager.getSettings();
    const mayAutoDownload = settings.preferredProvider === 'bergamot' ||
      (settings.preferredProvider === 'auto' && settings.autoFallback);
    if (!mayAutoDownload) return true;

    const detectedSource = sourceLang === 'auto'
      ? (await manager.detectLanguage(text)).language
      : sourceLang;
    const normalizedSource = normalizeLanguageTag(detectedSource);
    const normalizedTarget = normalizeLanguageTag(target);

    if (normalizedSource === normalizedTarget || await manager.resolveProvider(normalizedSource, normalizedTarget)) {
      return true;
    }

    const installableModels = await manager.getInstallableBergamotModels();
    const model = installableModels.find((candidate: ModelPackage) =>
      normalizeLanguageTag(candidate.fromCode) === normalizedSource &&
      normalizeLanguageTag(candidate.toCode) === normalizedTarget
    );
    if (!model) {
      throw new Error(`No downloadable model is available for ${normalizedSource} → ${normalizedTarget}.`);
    }

    let confirmed = false;
    await confirmationWindow.show({
      model,
      onConfirm: () => {
        confirmed = true;
      },
      onCancel: () => {},
    });

    if (!confirmed) {
      setError('Model download cancelled.');
    }
    return confirmed;
  };

  const handleTranslate = async (overrideTarget?: string, overrideProvider?: ProviderId) => {
    setIsTranslating(true);
    setError(null);
    setProgress(null);
    try {
      const tgt = overrideTarget || targetLang;
      const source = getMessageTranslationSource(message);

      // For plaintext messages, convert the HTML body to plain text before translation
      // to prevent <br> and other HTML tags from being passed to the translation model
      const textToTranslate = source.isPlaintext
        ? htmlToPlaintext(source.body)
        : source.body;

      if (!await confirmModelDownloadIfNeeded(textToTranslate, tgt)) return;

      const res = await manager.translate({
        id: `msg_${message.id}_${Date.now()}`,
        text: textToTranslate,
        sourceLang: sourceLang,
        targetLang: tgt,
        isHtml: !source.isPlaintext,
        providerId: overrideProvider,
        onProgress: (percent: number, message: string) => {
          setProgress({ percent, message });
        },
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
      setProgress(null);
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
                {sourceLang === 'auto'
                  ? (detectedLang ? getLanguageDisplayName(detectedLang) : 'Detected')
                  : getLanguageDisplayName(sourceLang)
                } → {getLanguageDisplayName(targetLang)}
              </span>
              <span className="offline-translator-provider-badge">
                {translationResult.providerName}
              </span>
            </div>
          )}

          {/* Source language selector */}
          <div className="offline-translator-lang-selector">
            <span className="offline-translator-lang-label">From:</span>
            <select
              value={sourceLang}
              onChange={(e) => {
                const nextSource = e.target.value;
                setSourceLang(nextSource);
                if (translationResult) {
                  handleTranslate(undefined, undefined);
                }
              }}
            >
              <option value="auto">🔍 Detect Language</option>
              {languages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name} ({l.code})
                </option>
              ))}
            </select>
          </div>

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

      {/* Progress bar for model download - centered below the header row */}
      {progress && (
        <div className="offline-translator-progress">
          <div className="offline-translator-progress-bar">
            <div
              className="offline-translator-progress-bar-fill"
              style={{ width: `${progress.percent}%` }}
            />
          </div>
          <span className="offline-translator-progress-message">{progress.message}</span>
        </div>
      )}

      {/* Error state */}
      {error && (
        <div className="offline-translator-header-error">
          ⚠️ {error}
        </div>
      )}
    </div>
  );
};

MessageTranslatorHeader.displayName = 'MessageTranslatorHeader';