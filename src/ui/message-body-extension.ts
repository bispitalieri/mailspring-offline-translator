import { TranslationResult } from '../types';

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
// Store the original body for each message when first encountered
const originalBodies = new Map<string, string>();

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
  
  if (!presentation) {
    // If this is a new message we haven't seen before, save its body as the original.
    // We do NOT strip any HTML here because we want to preserve the exact original body.
    if (!originalBodies.has(message.id)) {
      originalBodies.set(message.id, message.body);
    }
    // If we have a saved original body and the current body differs, restore it
    // This handles the case where Mailspring reuses the same message object
    const savedOriginal = originalBodies.get(message.id);
    if (savedOriginal && message.body !== savedOriginal) {
      message.body = savedOriginal;
    }
    return;
  }
  
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
    message.body = formatSplitView(presentation.originalBody, presentation.translatedBody);
  } else {
    // mode === 'original': restore the original body
    message.body = presentation.originalBody;
  }
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

// Update Mailspring's cache with the translated body so the user sees the translation.
async function updateMessageBodyCache(
  message: RenderableMessage,
  body: string,
  isPlaintext: boolean
): Promise<void> {
  const mailspringExports = require('mailspring-exports') as {
    MessageBodyProcessor?: { updateCacheForMessage: (message: RenderableMessage) => Promise<void> };
  };
  const processor = mailspringExports.MessageBodyProcessor;
  if (!processor || typeof processor.updateCacheForMessage !== 'function') {
    return;
  }

  const renderingMessage = message.clone ? message.clone() : { ...message };
  if (isPlaintext) {
    renderingMessage.plaintext = false;
  }
  renderingMessage.body = isPlaintext ? asPlaintextHtml(body) : body;
  await processor.updateCacheForMessage(renderingMessage);
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
  
  // Save the original body so we can restore it when the message is cleared.
  // IMPORTANT: we must save the original body BEFORE any translation is applied,
  // so that we always have the truly original message content.
  if (!originalBodies.has(message.id)) {
    originalBodies.set(message.id, originalBody);
  }
  
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

  // Apply the presentation immediately by modifying message.body in memory.
  formatWithPresentation(message, nextPresentation);

  // Update Mailspring's cache so the user sees the translation.
  try {
    await updateMessageBodyCache(message, message.body, plaintext);
  } catch (error) {
    console.warn('[Offline Translator] Failed to update message cache:', error);
  }
}

export function clearMessageTranslationPresentation(
  message: RenderableMessage | string
): void {
  const messageId = typeof message === 'string' ? message : message.id;
  const presentation = presentations.get(messageId);
  if (presentation && typeof message !== 'string') {
    // Restore the original body before clearing the presentation
    message.body = presentation.originalBody;
  }
  presentations.delete(messageId);
}

export function resetMessageToOriginal(message: RenderableMessage): void {
  const messageId = message.id;
  const presentation = presentations.get(messageId);
  
  if (presentation) {
    // Restore the original body from the presentation
    message.body = presentation.originalBody;
    presentations.delete(messageId);
  }
  
  // We do NOT update Mailspring's cache here. The original body is already in the
  // database because we never saved the translated body. When the user switches
  // emails, Mailspring will load the original body from the database.
}

export function clearMessageTranslationPresentations(): void {
  presentations.clear();
  originalBodies.clear();
}

export class OfflineTranslatorMessageViewExtension {
  static displayName = 'OfflineTranslatorMessageViewExtension';

  static formatMessageBody = ({ message }: { message: RenderableMessage }): void => {
    formatMessageBody(message);
  };
}
