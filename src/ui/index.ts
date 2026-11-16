/**
 * Mailspring Offline Translator - UI Components
 */

export { MessageTranslatorHeader } from './message-translator-extension';
export { ComposerTranslatorButton } from './composer-translator-extension';
export { OfflineTranslatorSettingsTab } from './settings-tab';
export {
  getMessageTranslationSource,
  formatMessageBody,
  formatWithPresentation,
  sanitizeTranslatedHtml,
  setMessageTranslationPresentation,
  clearMessageTranslationPresentations,
  OfflineTranslatorMessageViewExtension,
} from './message-body-extension';
export { confirmationWindow } from './confirmation-window';
