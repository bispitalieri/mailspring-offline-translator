/**
 * Mailspring Composer Translator Extension
 * 
 * Injects a "Translate Draft" action button into Mailspring's composer action bar ('Composer:ActionButton').
 * Clicking opens a safe side-by-side preview modal allowing the user to inspect
 * the translated draft, select target language, and explicitly confirm replacement.
 * 
 * Safety invariants:
 * - Never sends automatically.
 * - Never overwrites the original draft without explicit confirmation.
 * - Preserves rich text styling and hyperlinks.
 */

import React, { useState } from '../utils/react-runtime';
import { TranslationManager } from '../core/translation-manager';
import { ProviderId } from '../types';
import { getLanguageDisplayName, getCommonLanguages } from '../utils/bcp47';

export interface ComposerSession {
  draft?: {
    body?: string;
    subject?: string;
  };
  changes?: {
    add: (changes: { body?: string; subject?: string }) => void;
  };
  setDraftBody?: (newBody: string) => void;
}

export const ComposerTranslateModal: React.FC<{
  isOpen: boolean;
  onClose: () => void;
  draftBody: string;
  onConfirmReplace: (translatedBody: string) => void;
  manager: TranslationManager;
}> = ({ isOpen, onClose, draftBody, onConfirmReplace, manager }) => {
  const [targetLang, setTargetLang] = useState<string>(() => manager.getEffectiveTargetLanguage());
  const [translatedText, setTranslatedText] = useState<string>('');
  const [isTranslating, setIsTranslating] = useState<boolean>(false);
  const [detectedLang, setDetectedLang] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hasTranslated, setHasTranslated] = useState<boolean>(false);
  const [selectedProvider, setSelectedProvider] = useState<ProviderId>('auto');

  const languages = getCommonLanguages();

  if (!isOpen) return null;

  const handleTranslate = async () => {
    setIsTranslating(true);
    setError(null);
    try {
      const res = await manager.translate({
        id: `draft_${Date.now()}`,
        text: draftBody || '',
        sourceLang: 'auto',
        targetLang,
        isHtml: true,
        providerId: selectedProvider === 'auto' ? undefined : selectedProvider,
      });
      setTranslatedText(res.translatedText);
      setDetectedLang(res.detectedSourceLang || null);
      setHasTranslated(true);
    } catch (err: any) {
      setError(err.message || 'Failed to translate draft.');
    } finally {
      setIsTranslating(false);
    }
  };

  const handleApply = () => {
    if (translatedText) {
      onConfirmReplace(translatedText);
      onClose();
    }
  };

  return (
    <div className="offline-translator-composer-backdrop">
      <div className="offline-translator-composer-modal">
        {/* Header */}
        <div className="offline-translator-modal-header">
          <div className="offline-translator-modal-title-group">
            <span className="offline-translator-modal-icon">
              <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
              </svg>
            </span>
            <div>
              <h3 className="offline-translator-modal-title">Translate Draft (Offline Preview)</h3>
              <p className="offline-translator-modal-subtitle">Review translation before applying to your draft.</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="offline-translator-modal-close"
          >
            ✕
          </button>
        </div>

        {/* Toolbar */}
        <div className="offline-translator-modal-toolbar">
          <div className="offline-translator-toolbar-left">
            <span className="offline-translator-toolbar-label">Target Language:</span>
            <select
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
            >
              {languages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name} ({l.code})
                </option>
              ))}
            </select>
            <span className="offline-translator-toolbar-label">Provider:</span>
            <select
              value={selectedProvider}
              onChange={(e) => setSelectedProvider(e.target.value as ProviderId)}
            >
              <option value="auto">Automatic</option>
              <option value="opus">OPUS-MT</option>
            </select>
            {detectedLang && (
              <span className="offline-translator-detected-lang">
                Source detected: <strong>{getLanguageDisplayName(detectedLang)}</strong>
              </span>
            )}
          </div>
          <button
            onClick={handleTranslate}
            disabled={isTranslating}
            className="offline-translator-primary-btn"
          >
            {isTranslating ? 'Translating...' : hasTranslated ? 'Re-Translate' : 'Generate Translation'}
          </button>
        </div>

        {/* Comparison Body */}
        <div className="offline-translator-comparison">
          {/* Left: Original Draft */}
          <div className="offline-translator-panel">
            <div className="offline-translator-panel-label">
              Original Draft
            </div>
            <div
              className="offline-translator-prose"
              dangerouslySetInnerHTML={{ __html: draftBody || '<p class="offline-translator-empty">No draft content</p>' }}
            />
          </div>

          {/* Right: Translated Preview */}
          <div className="offline-translator-panel offline-translator-panel-translated">
            <div className="offline-translator-panel-header">
              <span className="offline-translator-panel-label offline-translator-panel-label-accent">
                Translated Draft ({getLanguageDisplayName(targetLang)})
              </span>
              {hasTranslated && (
                <span className="offline-translator-hint">Preserves HTML & Links</span>
              )}
            </div>

            {isTranslating ? (
              <div className="offline-translator-loading">
                <span className="offline-translator-spinner" />
                <span className="offline-translator-loading-text">Processing offline model inference...</span>
              </div>
            ) : error ? (
              <div className="offline-translator-error-box">
                ⚠️ {error}
              </div>
            ) : hasTranslated ? (
              <div
                className="offline-translator-prose"
                dangerouslySetInnerHTML={{ __html: translatedText }}
              />
            ) : (
              <div className="offline-translator-empty-state">
                Click "Generate Translation" to preview your translated email.
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="offline-translator-modal-footer">
          <span className="offline-translator-footer-hint">
            🔒 Pure on-device translation. Never sent automatically.
          </span>
          <div className="offline-translator-footer-buttons">
            <button
              onClick={onClose}
              className="offline-translator-secondary-btn"
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              disabled={!hasTranslated || isTranslating}
              className="offline-translator-success-btn"
            >
              Replace Draft with Translation
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export const ComposerTranslatorButton: React.FC<{
  draft?: { body?: string };
  session?: ComposerSession;
  manager?: TranslationManager;
}> = (props) => {
  const [modalOpen, setModalOpen] = useState(false);
  const manager = props.manager || (window as any).__mailspring_offline_translator_manager || new TranslationManager();

  const draftBody = props.draft?.body || props.session?.draft?.body || '';

  const handleConfirmReplace = (translatedBody: string) => {
    if (props.session?.changes?.add) {
      props.session.changes.add({ body: translatedBody });
    } else if (props.session?.setDraftBody) {
      props.session.setDraftBody(translatedBody);
    }
  };

  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        title="Translate Draft Offline"
        className="btn btn-toolbar offline-translator-composer-btn"
        onClick={() => setModalOpen(true)}
      >
        <svg fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
        </svg>
        <span>Translate</span>
      </button>

      <ComposerTranslateModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        draftBody={draftBody}
        onConfirmReplace={handleConfirmReplace}
        manager={manager}
      />
    </>
  );
};
