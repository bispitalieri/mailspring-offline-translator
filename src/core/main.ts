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
import * as MailspringExports from "mailspring-exports";
import { TranslationManager } from './translation-manager';
import { MessageTranslatorHeader, ComposerTranslatorButton, OfflineTranslatorSettingsTab, clearMessageTranslationPresentations, OfflineTranslatorMessageViewExtension } from '../ui';
import {ProcessManager} from '../utils';

const {ComponentRegistry, ExtensionRegistry} = MailspringExports;
const PreferencesUIStore = (MailspringExports as any).PreferencesUIStore;
let preferencesTab: any;

let managerInstance: TranslationManager | null = null;

const PREFERENCES_TAB_ID = 'Offline Translator';

export function activate(): void {
  // Initialize singleton TranslationManager only if not already restored by deserialize()
  managerInstance ??= new TranslationManager();
  (globalThis as any).__mailspring_offline_translator_manager = managerInstance;

  try {
    ExtensionRegistry.MessageView.register(OfflineTranslatorMessageViewExtension);

    // 1. Message Body Header extension (non-destructive translation bar)
    ComponentRegistry.register(MessageTranslatorHeader, {
      role: 'message:BodyHeader',
    });

    // 2. Composer Action Bar button (safe preview & confirmation)
    ComponentRegistry.register(ComposerTranslatorButton, {
      role: 'Composer:ActionButton',
    });

    console.info('[Mailspring Offline Translator] Registered message and composer components.');
  } catch (e) {
    console.warn('[Mailspring Offline Translator] ComponentRegistry not detected (running outside Mailspring). ', e);
  }

  if (PreferencesUIStore) {
    preferencesTab = new PreferencesUIStore.TabItem({
      tabId: PREFERENCES_TAB_ID,
      displayName: 'Offline Translator',
      componentClassFn: () => OfflineTranslatorSettingsTab,
      order: 100,
    });
    PreferencesUIStore.registerPreferencesTab(preferencesTab);
    console.info(`[Mailspring Offline Translator] Registered Preferences tab "${PREFERENCES_TAB_ID}".`);
  } else {
    console.warn('[Mailspring Offline Translator] PreferencesUIStore not detected; settings tab was not registered.');
  }

  console.info('[Mailspring Offline Translator] Plugin activated successfully (message, composer, and settings integrations).');
}

export function deactivate(): void {
  ComponentRegistry.unregister(MessageTranslatorHeader);
  ComponentRegistry.unregister(ComposerTranslatorButton);
  ExtensionRegistry.MessageView.unregister(OfflineTranslatorMessageViewExtension);

  clearMessageTranslationPresentations();

  if (PreferencesUIStore && preferencesTab) {
    PreferencesUIStore.unregisterPreferencesTab(preferencesTab);
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

export function deserialize(data: Record<string, any>): void {
  if (data?.settings) {
    if (managerInstance) {
      managerInstance.updateSettings(data.settings);
    } else {
      managerInstance = new TranslationManager(data.settings);
      (globalThis as any).__mailspring_offline_translator_manager = managerInstance;
    }
  }
}

export function getManager(): TranslationManager | null {
  return managerInstance;
}
