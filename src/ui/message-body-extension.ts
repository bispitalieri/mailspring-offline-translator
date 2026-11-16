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
// Track which messages are plaintext so we can restore the flag when resetting
const plaintextMessages = new Set<string>();
// Track the current message ID so we can restore its cache when switching emails
let currentMessageId: string | null = null;

export function getMessageTranslationSource(message: RenderableMessage): {
  body: string;
  isPlaintext: boolean;
} {
  const presentation = presentations.get(message.id);
  // Usa originalBodies per recuperare il corpo originale vero e proprio,
  // perché presentation?.originalBody per i messaggi plaintext è già stato
  // convertito in testo puro da htmlToPlaintext().
  const originalBody = originalBodies.get(message.id) ?? message.body;
  const isPlaintext = plaintextMessages.has(message.id) || Boolean(message.plaintext);
  return {
    body: presentation?.originalBody ?? originalBody,
    isPlaintext,
  };
}

/**
 * Converte i tag HTML comuni nei messaggi plaintext in caratteri di testo.
 * I messaggi plaintext possono contenere tag <br> o <br/> inseriti dal client email
 * che devono essere convertiti in newline prima della traduzione.
 */
export function htmlToPlaintext(text: string): string {
  // Converte i tag <br> e varianti in newline
  let result = text.replace(/<br\s*\/?>/gi, '\n');
  // Rimuove eventuali altri tag HTML residui
  result = result.replace(/<[^>]*>/g, '');
  // Decodifica le entità HTML comuni
  result = result.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  result = result.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  result = result.replace(/&nbsp;/g, ' ');
  // Decodifica le entità numeriche
  result = result.replace(/&#(\d+);/g, (_, decimal) => String.fromCharCode(parseInt(decimal, 10)));
  result = result.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return result;
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
  // Converte i newline in <br> per preservare le interruzioni di riga nell'HTML
  const escaped = escapeHtml(text);
  const withBreaks = escaped.replace(/\n/g, '<br>\n');
  return `<pre style="white-space: pre-wrap; overflow-wrap: anywhere">${withBreaks}</pre>`;
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

// Rileva se un corpo contiene HTML generato dal plugin di traduzione
function isPluginGeneratedHtml(body: string): boolean {
  // L'HTML della split view contiene grid-template-columns
  if (body.includes('grid-template-columns')) {
    return true;
  }
  // L'HTML dei plaintext wrapper contiene il nostro style specifico
  if (body.includes('white-space: pre-wrap; overflow-wrap: anywhere')) {
    return true;
  }
  return false;
}

// Rileva se un corpo è corrotto da doppio escaping (es. &lt;pre&gt; invece di <pre>)
function isCorruptedBody(body: string): boolean {
  // Entità HTML escapeate che indicano doppio escaping
  if (body.includes('&lt;pre')) {
    return true;
  }
  if (body.includes('&lt;br')) {
    return true;
  }
  if (body.includes('&amp;#39;')) {
    return true;
  }
  if (body.includes('&amp;lt;')) {
    return true;
  }
  return false;
}

// Ripristina un corpo corrotto decodificando le entità HTML escapeate
function restoreCorruptedBody(body: string): string {
  let restored = body;
  // Decodifica le entità doppio-escaped
  restored = restored.replace(/&amp;lt;/g, '&lt;');
  restored = restored.replace(/&amp;gt;/g, '&gt;');
  restored = restored.replace(/&amp;amp;/g, '&amp;');
  restored = restored.replace(/&amp;quot;/g, '&quot;');
  restored = restored.replace(/&amp;#39;/g, '&#39;');
  restored = restored.replace(/&amp;nbsp;/g, '&nbsp;');
  // Decodifica le entità HTML comuni
  restored = restored.replace(/&lt;/g, '<');
  restored = restored.replace(/&gt;/g, '>');
  restored = restored.replace(/&amp;/g, '&');
  restored = restored.replace(/&quot;/g, '"');
  restored = restored.replace(/&#39;/g, "'");
  restored = restored.replace(/&nbsp;/g, ' ');
  // Decodifica le entità numeriche
  restored = restored.replace(/&#(\d+);/g, (_, decimal) => String.fromCharCode(parseInt(decimal, 10)));
  restored = restored.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
  return restored;
}

export function formatMessageBody(message: RenderableMessage): void {
  const presentation = presentations.get(message.id);

  if (!presentation) {
    // If this is a new message we haven't seen before, save its body as the original.
    // We do NOT strip any HTML here because we want to preserve the exact original body.
    // IMPORTANT: Se il corpo contiene HTML generato dal plugin (es. split view), non
    // registrarlo come originale - è un corpo corrotto dalla cache di Mailspring.
    // Se il corpo è corrotto (doppio escaping), ripristinalo prima di registrarlo.
    if (!originalBodies.has(message.id)) {
      if (isPluginGeneratedHtml(message.body)) {
        // Corpo corrotto dalla cache di Mailspring - non registrarlo come originale
        // Il corpo originale dovrebbe già essere in originalBodies
      } else if (isCorruptedBody(message.body)) {
        // Corpo corrotto da doppio escaping - ripristinalo e registralo come originale
        const restored = restoreCorruptedBody(message.body);
        originalBodies.set(message.id, restored);
        message.body = restored;
        // Se il corpo originale conteneva inbox-plain-wrapper, è un messaggio plaintext
        if (restored.includes('inbox-plain-wrapper')) {
          message.plaintext = true;
          plaintextMessages.add(message.id);
        }
      } else {
        // Corpo originale - registralo
        originalBodies.set(message.id, message.body);
      }
    }
    // If we have a saved original body and the current body differs, restore it.
    // This handles the case where Mailspring loads a modified body from its cache
    // (e.g., after the user translated, switched messages, and came back).
    const savedOriginal = originalBodies.get(message.id);
    if (savedOriginal && message.body !== savedOriginal) {
      message.body = savedOriginal;
      // Restore the plaintext flag if this message was originally plaintext
      if (plaintextMessages.has(message.id)) {
        message.plaintext = true;
      }
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
    const bodyHtml =
      presentation.mode === 'inline'
        ? translated
        : presentation.mode === 'split'
          ? formatSplitView(original, translated)
          : original;
    message.body = bodyHtml;
    // Imposta plaintext = false così Mailspring rende l'HTML come HTML, non come testo escapeato
    message.plaintext = false;
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

// Aggiorna la cache di Mailspring con il corpo specificato.
async function updateMessageBodyCache(
  message: RenderableMessage,
  body: string,
  isPlaintext: boolean = false
): Promise<void> {
  const mailspringExports = require('mailspring-exports') as {
    MessageBodyProcessor?: { updateCacheForMessage: (message: RenderableMessage) => Promise<void> };
  };
  const processor = mailspringExports.MessageBodyProcessor;
  if (!processor || typeof processor.updateCacheForMessage !== 'function') {
    return;
  }

  const renderingMessage = message.clone ? message.clone() : { ...message };
  renderingMessage.body = body;
  // Per i messaggi plaintext, impostiamo plaintext = false così Mailspring
  // rende l'HTML generato dal plugin (split view o inline) come HTML, non come testo escapeato.
  if (isPlaintext) {
    renderingMessage.plaintext = false;
  }
  await processor.updateCacheForMessage(renderingMessage);
}

// Ripristina la cache di un messaggio con il corpo originale.
// Viene chiamato quando l'utente cambia email per garantire che la cache
// del messaggio precedente contenga il corpo originale, non la traduzione.
export async function restoreMessageCache(messageId: string): Promise<void> {
  const originalBody = originalBodies.get(messageId);
  if (!originalBody) {
    return;
  }

  const isPlaintext = plaintextMessages.has(messageId);

  const mailspringExports = require('mailspring-exports') as {
    MessageBodyProcessor?: { updateCacheForMessage: (message: any) => Promise<void> };
  };
  const processor = mailspringExports.MessageBodyProcessor;
  if (!processor || typeof processor.updateCacheForMessage !== 'function') {
    return;
  }

  // Creiamo un oggetto message minimale per aggiornare la cache.
  // Mailspring si aspetta un oggetto con un metodo clone(), quindi lo aggiungiamo.
  const cacheMessage: RenderableMessage = {
    id: messageId,
    body: originalBody,
    plaintext: isPlaintext,
    clone: function() {
      return { ...this };
    },
  };
  await processor.updateCacheForMessage(cacheMessage);
}

// Ripristina la cache del messaggio corrente (quello attualmente visualizzato)
// con il corpo originale. Viene chiamato quando l'utente sta per cambiare email.
export async function restoreCurrentMessageCache(): Promise<void> {
  if (currentMessageId) {
    await restoreMessageCache(currentMessageId);
  }
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

  // Track plaintext messages so we can restore the plaintext flag when resetting
  if (plaintext) {
    plaintextMessages.add(message.id);
  }

  // Per i messaggi plaintext, convertiamo il corpo originale in testo puro
  // per evitare che i tag HTML vengano visualizzati come testo escapeato
  const cleanOriginalBody = plaintext ? htmlToPlaintext(originalBody) : originalBody;

  const nextPresentation: MessagePresentation = {
    originalBody: cleanOriginalBody,
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

  // Aggiorniamo la cache di Mailspring con la traduzione così l'utente la vede.
  // Quando l'utente cambia email, la cache verrà ripristinata con il corpo originale
  // tramite restoreMessageCache() prima di passare alla nuova email.
  try {
    await updateMessageBodyCache(message, message.body, plaintext);
  } catch (error) {
    console.warn('[Offline Translator] Failed to update message cache:', error);
  }

  // Tracciamo il messaggio corrente così sappiamo quale cache ripristinare
  // quando l'utente cambia email.
  currentMessageId = message.id;
}

export function clearMessageTranslationPresentation(
  message: RenderableMessage | string
): void {
  const messageId = typeof message === 'string' ? message : message.id;
  const presentation = presentations.get(messageId);
  if (presentation && typeof message !== 'string') {
    // Usa originalBodies per recuperare il corpo originale vero e proprio,
    // perché presentation.originalBody per i messaggi plaintext è già stato
    // convertito in testo puro da htmlToPlaintext().
    const trueOriginal = originalBodies.get(messageId);
    if (trueOriginal) {
      message.body = trueOriginal;
    } else {
      message.body = presentation.originalBody;
    }
    // Ripristina il flag plaintext per i messaggi plaintext
    if (presentation.isPlaintext) {
      message.plaintext = true;
    }
  }
  presentations.delete(messageId);
}

export async function resetMessageToOriginal(message: RenderableMessage): Promise<void> {
  const messageId = message.id;
  const presentation = presentations.get(messageId);

  if (presentation) {
    // Usa originalBodies per recuperare il corpo originale vero e proprio,
    // perché presentation.originalBody per i messaggi plaintext è già stato
    // convertito in testo puro da htmlToPlaintext().
    const trueOriginal = originalBodies.get(messageId);
    const bodyToRestore = trueOriginal ?? presentation.originalBody;
    message.body = bodyToRestore;

    // Ripristina il flag plaintext per i messaggi plaintext
    if (presentation.isPlaintext) {
      message.plaintext = true;
    }

    presentations.delete(messageId);
  }
}

export function clearMessageTranslationPresentations(): void {
  presentations.clear();
  originalBodies.clear();
  plaintextMessages.clear();
  currentMessageId = null;
}

export class OfflineTranslatorMessageViewExtension {
  static displayName = 'OfflineTranslatorMessageViewExtension';

  static formatMessageBody = ({ message }: { message: RenderableMessage }): void => {
    formatMessageBody(message);
  };
}
