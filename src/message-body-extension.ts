import { TranslationResult } from './types';

export type TranslationViewMode = 'inline' | 'split' | 'original';

interface RenderableMessage {
  id: string;
  body: string;
  plaintext?: boolean;
  clone?: () => RenderableMessage;
}

export interface MessagePresentation {
  originalBody: string;
  translatedBody: string;
  isPlaintext: boolean;
  mode: TranslationViewMode;
}

const presentations = new Map<string, MessagePresentation>();
const pendingUpdates = new Map<string, Promise<void>>();

export function getMessageTranslationSource(message: RenderableMessage): {
  body: string;
  isPlaintext: boolean;
} {
  const presentation = presentations.get(message.id);
  return {
    body: presentation?.originalBody ?? message.body,
    isPlaintext: presentation?.isPlaintext ?? Boolean(message.plaintext),
  };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character];
  });
}

function asPlaintextHtml(text: string): string {
  return `<pre style="white-space: pre-wrap; overflow-wrap: anywhere">${escapeHtml(text)}</pre>`;
}

function formatSplitView(original: string, translated: string): string {
  return (
    '<div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px">' +
    '<section style="min-width:0"><div style="font-weight:600;margin-bottom:8px">Original</div>' +
    original +
    '</section>' +
    '<section style="min-width:0;border-left:1px solid #ccc;padding-left:16px">' +
    '<div style="font-weight:600;margin-bottom:8px">Translated</div>' +
    translated +
    '</section></div>'
  );
}

export function formatMessageBody(message: RenderableMessage): void {
  const presentation = presentations.get(message.id);
  if (!presentation) return;
  formatWithPresentation(message, presentation);
}

export function formatWithPresentation(
  message: RenderableMessage,
  presentation: MessagePresentation
): void {
  if (presentation.isPlaintext) {
    const original = asPlaintextHtml(presentation.originalBody);
    const translated = asPlaintextHtml(presentation.translatedBody);
    message.body =
      presentation.mode === 'inline'
        ? translated
        : presentation.mode === 'split'
          ? formatSplitView(original, translated)
          : original;
    return;
  }

  if (presentation.mode === 'inline') {
    message.body = presentation.translatedBody;
  } else if (presentation.mode === 'split') {
    message.body = formatSplitView(message.body, presentation.translatedBody);
  }
}

function updateMessageBodyCache(
  message: RenderableMessage,
  originalBody: string,
  isPlaintext: boolean
): Promise<void> {
  const mailspringExports = require('mailspring-exports') as {
    MessageBodyProcessor?: { updateCacheForMessage: (message: RenderableMessage) => Promise<void> };
  };
  const processor = mailspringExports.MessageBodyProcessor;
  if (!processor || typeof processor.updateCacheForMessage !== 'function') {
    throw new Error('Mailspring MessageBodyProcessor is unavailable.');
  }

  const renderingMessage = message.clone ? message.clone() : { ...message };
  if (isPlaintext) {
    renderingMessage.plaintext = false;
  }
  renderingMessage.body = isPlaintext ? asPlaintextHtml(originalBody) : originalBody;

  const previous = pendingUpdates.get(message.id) || Promise.resolve();
  const next = previous.catch(() => undefined).then(() => processor.updateCacheForMessage(renderingMessage));
  pendingUpdates.set(message.id, next);
  return next.finally(() => {
    if (pendingUpdates.get(message.id) === next) {
      pendingUpdates.delete(message.id);
    }
  });
}

export async function sanitizeTranslatedHtml(html: string): Promise<string> {
  const mailspringExports = require('mailspring-exports') as {
    SanitizeTransformer?: { run: (html: string) => Promise<string> };
  };
  const sanitizer = mailspringExports.SanitizeTransformer;
  if (!sanitizer || typeof sanitizer.run !== 'function') {
    throw new Error('Mailspring HTML sanitizer is unavailable.');
  }
  return sanitizer.run(html);
}

export async function setMessageTranslationPresentation(
  message: RenderableMessage,
  translation: TranslationResult,
  mode: TranslationViewMode,
  isPlaintext?: boolean
): Promise<void> {
  const previousPresentation = presentations.get(message.id);
  const originalBody = previousPresentation?.originalBody ?? message.body;
  const plaintext = previousPresentation?.isPlaintext ?? Boolean(isPlaintext ?? message.plaintext);
  const nextPresentation: MessagePresentation = {
    originalBody,
    translatedBody: translation.translatedText,
    isPlaintext: plaintext,
    mode,
  };
  presentations.set(message.id, nextPresentation);

  if (presentations.size > 50) {
    const oldestId = presentations.keys().next().value;
    if (oldestId) presentations.delete(oldestId);
  }

  try {
    await updateMessageBodyCache(message, originalBody, plaintext);
  } catch (error) {
    if (presentations.get(message.id) === nextPresentation) {
      if (previousPresentation) {
        presentations.set(message.id, previousPresentation);
      } else {
        presentations.delete(message.id);
      }
    }
    throw error;
  }
}

export function clearMessageTranslationPresentations(): void {
  presentations.clear();
}

export class OfflineTranslatorMessageViewExtension {
  static displayName = 'OfflineTranslatorMessageViewExtension';

  static formatMessageBody = ({ message }: { message: RenderableMessage }): void => {
    formatMessageBody(message);
  };
}
