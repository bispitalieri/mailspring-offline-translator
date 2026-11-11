/**
 * Mailspring Offline Translator - Main Plugin Entry Point
 * 
 * Implements standard Mailspring extension registration:
 * - Registers the message body formatter and MessageTranslatorHeader
 * - Registers MessageTranslatorHeader in ComponentRegistry ('message:BodyHeader')
 * - Registers ComposerTranslatorButton in ComponentRegistry ('Composer:ActionButton')
 * - Registers settings through PreferencesUIStore
 * - Compiles to executable CommonJS in lib/main.js
 */

import { TranslationManager } from './translation-manager';
import { MessageTranslatorHeader } from './message-translator-extension';
import { ComposerTranslatorButton } from './composer-translator-extension';
import { OfflineTranslatorSettingsTab } from './settings-tab';
import { ProcessManager } from './process-manager';
import {
  clearMessageTranslationPresentations,
  OfflineTranslatorMessageViewExtension,
} from './message-body-extension';

let managerInstance: TranslationManager | null = null;
let preferencesTabId: string | null = null;

const PREFERENCES_TAB_ID = 'Offline Translator';

function getComponentRegistry(): any {
  try {
    // Standard Mailspring Electron runtime export
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mailspringExports = require('mailspring-exports');
    if (mailspringExports && mailspringExports.ComponentRegistry) {
      return mailspringExports.ComponentRegistry;
    }
  } catch {
    // Fallback to global symbol if exposed on window / global
  }

  if (typeof (globalThis as any).ComponentRegistry !== 'undefined') {
    return (globalThis as any).ComponentRegistry;
  }

  return null;
}

function getMessageViewRegistry(): any {
  try {
    const mailspringExports = require('mailspring-exports');
    if (mailspringExports?.ExtensionRegistry?.MessageView) {
      return mailspringExports.ExtensionRegistry.MessageView;
    }
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'MODULE_NOT_FOUND' &&
      'message' in error &&
      typeof error.message === 'string' &&
      error.message.includes("Cannot find module 'mailspring-exports'")
    ) {
      // Allow the global fallback used by the Mailspring test harness.
    } else {
      throw error;
    }
  }

  return (globalThis as any).ExtensionRegistry?.MessageView ?? null;
}

function getPreferencesUIStore(): any {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mailspringExports = require('mailspring-exports');
    if (mailspringExports?.PreferencesUIStore) {
      return mailspringExports.PreferencesUIStore;
    }
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'MODULE_NOT_FOUND' &&
      'message' in error &&
      typeof error.message === 'string' &&
      error.message.includes("Cannot find module 'mailspring-exports'")
    ) {
      // Allow the global fallback used by the Mailspring test harness.
    } else {
      throw error;
    }
  }

  return (globalThis as any).PreferencesUIStore ?? null;
}

export function activate(): void {
  // Initialize singleton TranslationManager
  managerInstance = new TranslationManager();
  (globalThis as any).__mailspring_offline_translator_manager = managerInstance;

  const registry = getComponentRegistry();
  const messageViewRegistry = getMessageViewRegistry();
  if (messageViewRegistry && typeof messageViewRegistry.register === 'function') {
    messageViewRegistry.register(OfflineTranslatorMessageViewExtension);
  }
  if (registry && typeof registry.register === 'function') {
    MessageTranslatorHeader.displayName = 'MessageTranslatorHeader';
    ComposerTranslatorButton.displayName = 'ComposerTranslatorButton';
    OfflineTranslatorSettingsTab.displayName = 'OfflineTranslatorSettingsTab';

    // 1. Message Body Header extension (non-destructive translation bar)
    registry.register(MessageTranslatorHeader, {
      role: 'message:BodyHeader',
    });

    // 2. Composer Action Bar button (safe preview & confirmation)
    registry.register(ComposerTranslatorButton, {
      role: 'Composer:ActionButton',
    });

    console.info('[Mailspring Offline Translator] Registered message and composer components.');
  } else {
    console.warn('[Mailspring Offline Translator] ComponentRegistry not detected (running outside Mailspring).');
  }

  const preferencesUIStore = getPreferencesUIStore();
  if (preferencesUIStore?.TabItem && typeof preferencesUIStore.registerPreferencesTab === 'function') {
    OfflineTranslatorSettingsTab.displayName = 'OfflineTranslatorSettingsTab';
    const tab = new preferencesUIStore.TabItem({
      tabId: PREFERENCES_TAB_ID,
      displayName: 'Offline Translator',
      componentClassFn: () => OfflineTranslatorSettingsTab,
    });
    preferencesUIStore.registerPreferencesTab(tab);
    preferencesTabId = PREFERENCES_TAB_ID;
    console.info(`[Mailspring Offline Translator] Registered Preferences tab "${PREFERENCES_TAB_ID}".`);
  } else {
    console.warn('[Mailspring Offline Translator] PreferencesUIStore not detected; settings tab was not registered.');
  }

  console.info('[Mailspring Offline Translator] Plugin activated successfully (message, composer, and settings integrations).');
}

export function deactivate(): void {
  const registry = getComponentRegistry();
  if (registry && typeof registry.unregister === 'function') {
    try {
      registry.unregister(MessageTranslatorHeader);
      registry.unregister(ComposerTranslatorButton);
      registry.unregister(OfflineTranslatorSettingsTab);
    } catch (err) {
      console.warn('[Mailspring Offline Translator] Error unregistering components:', err);
    }
  }
  const messageViewRegistry = getMessageViewRegistry();
  if (messageViewRegistry && typeof messageViewRegistry.unregister === 'function') {
    messageViewRegistry.unregister(OfflineTranslatorMessageViewExtension);
  }
  clearMessageTranslationPresentations();

  if (preferencesTabId) {
    const preferencesUIStore = getPreferencesUIStore();
    if (typeof preferencesUIStore?.unregisterPreferencesTab === 'function') {
      preferencesUIStore.unregisterPreferencesTab(preferencesTabId);
    }
    preferencesTabId = null;
  }

  if (managerInstance) {
    managerInstance.dispose();
    managerInstance = null;
  }

  delete (globalThis as any).__mailspring_offline_translator_manager;
  ProcessManager.terminateAll();

  console.info('[Mailspring Offline Translator] Plugin deactivated.');
}

export function serialize(): Record<string, any> {
  if (managerInstance) {
    return {
      settings: managerInstance.getSettings(),
    };
  }
  return {};
}

export function getManager(): TranslationManager | null {
  return managerInstance;
}
