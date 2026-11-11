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

import React, { useState } from './react-runtime';
import { TranslationManager } from './translation-manager';
import { getLanguageDisplayName, getCommonLanguages } from './bcp47';

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
      <div className="offline-translator-composer-modal flex max-h-[90vh] w-full max-w-4xl flex-col rounded-xl border border-neutral-700 bg-neutral-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-neutral-800 px-6 py-4">
          <div className="flex items-center space-x-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-cyan-600/20 text-cyan-400">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
              </svg>
            </span>
            <div>
              <h3 className="text-sm font-semibold text-neutral-100">Translate Draft (Offline Preview)</h3>
              <p className="text-xs text-neutral-400">Review translation before applying to your draft.</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-white"
          >
            ✕
          </button>
        </div>

        {/* Toolbar */}
        <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-950/40 px-6 py-3 text-xs">
          <div className="flex items-center space-x-3">
            <span className="text-neutral-400">Target Language:</span>
            <select
              value={targetLang}
              onChange={(e) => setTargetLang(e.target.value)}
              className="rounded border border-neutral-700 bg-neutral-800 px-2.5 py-1 text-xs text-neutral-100 focus:outline-none focus:ring-1 focus:ring-cyan-500"
            >
              {languages.map((l) => (
                <option key={l.code} value={l.code}>
                  {l.name} ({l.code})
                </option>
              ))}
            </select>
            {detectedLang && (
              <span className="rounded bg-neutral-800 px-2 py-0.5 text-neutral-400">
                Source detected: <strong className="text-neutral-200">{getLanguageDisplayName(detectedLang)}</strong>
              </span>
            )}
          </div>
          <button
            onClick={handleTranslate}
            disabled={isTranslating}
            className="rounded bg-cyan-600 px-3 py-1 font-medium text-white shadow-sm hover:bg-cyan-500 disabled:opacity-50"
          >
            {isTranslating ? 'Translating...' : hasTranslated ? 'Re-Translate' : 'Generate Translation'}
          </button>
        </div>

        {/* Comparison Body */}
        <div className="grid flex-1 grid-cols-1 divide-y divide-neutral-800 overflow-hidden md:grid-cols-2 md:divide-x md:divide-y-0">
          {/* Left: Original Draft */}
          <div className="flex flex-col overflow-y-auto p-4">
            <div className="mb-2 text-[11px] font-medium tracking-wide text-neutral-400 uppercase">
              Original Draft
            </div>
            <div
              className="prose prose-invert prose-sm max-w-none text-neutral-300"
              dangerouslySetInnerHTML={{ __html: draftBody || '<p class="text-neutral-500 italic">No draft content</p>' }}
            />
          </div>

          {/* Right: Translated Preview */}
          <div className="flex flex-col overflow-y-auto bg-neutral-950/20 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] font-medium tracking-wide text-cyan-400 uppercase">
                Translated Draft ({getLanguageDisplayName(targetLang)})
              </span>
              {hasTranslated && (
                <span className="text-[10px] text-neutral-400">Preserves HTML & Links</span>
              )}
            </div>

            {isTranslating ? (
              <div className="flex h-40 flex-col items-center justify-center space-y-2 text-neutral-400">
                <span className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-cyan-400 border-t-transparent" />
                <span className="text-xs">Processing offline model inference...</span>
              </div>
            ) : error ? (
              <div className="rounded bg-rose-950/80 p-3 text-xs text-rose-300 border border-rose-800/40">
                ⚠️ {error}
              </div>
            ) : hasTranslated ? (
              <div
                className="prose prose-invert prose-sm max-w-none text-neutral-200"
                dangerouslySetInnerHTML={{ __html: translatedText }}
              />
            ) : (
              <div className="flex h-40 items-center justify-center text-xs text-neutral-500 italic">
                Click "Generate Translation" to preview your translated email.
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-neutral-800 px-6 py-3.5 text-xs">
          <span className="text-neutral-400">
            🔒 Pure on-device translation. Never sent automatically.
          </span>
          <div className="flex space-x-2">
            <button
              onClick={onClose}
              className="rounded border border-neutral-700 px-3 py-1.5 font-medium text-neutral-300 hover:bg-neutral-800"
            >
              Cancel
            </button>
            <button
              onClick={handleApply}
              disabled={!hasTranslated || isTranslating}
              className="rounded bg-emerald-600 px-4 py-1.5 font-medium text-white shadow-sm hover:bg-emerald-500 disabled:opacity-40"
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
        className="btn btn-toolbar offline-translator-composer-btn inline-flex items-center gap-1 px-2 py-1 text-xs text-neutral-300 hover:text-cyan-400"
        onClick={() => setModalOpen(true)}
      >
        <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
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
