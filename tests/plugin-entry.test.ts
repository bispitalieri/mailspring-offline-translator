import test from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const require = createRequire(import.meta.url);

test('Plugin package.json defines valid executable entry point lib/main.js', () => {
  const pkgPath = path.resolve(__dirname, '../plugin/package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

  assert.equal(pkg.main, 'lib/main.js', 'package.json main must reference lib/main.js');
  assert.equal(pkg.displayName, 'Mailspring Offline Translator');
  
  const mainJsPath = path.resolve(__dirname, '../plugin/lib/main.js');
  assert.ok(fs.existsSync(mainJsPath), 'Compiled lib/main.js must exist on disk');

  const content = fs.readFileSync(mainJsPath, 'utf8');
  assert.ok(content.includes('exports.activate'), 'lib/main.js must export activate');
  assert.ok(content.includes('exports.deactivate'), 'lib/main.js must export deactivate');
  assert.ok(!content.includes('import '), 'Compiled lib/main.js must be executable CommonJS, not uncompiled TypeScript');
});

test('Plugin lib/main.js exports lifecycle methods and can activate/deactivate safely', () => {
  const plugin = require('../plugin/lib/main.js');
  const globalWithRegistry = globalThis as typeof globalThis & {
    ComponentRegistry?: {
      register: (component: { displayName?: string }, options: { role: string }) => void;
      unregister: () => void;
    };
    ExtensionRegistry?: {
      MessageView: {
        register: (extension: { displayName?: string }) => void;
        unregister: (extension: { displayName?: string }) => void;
      };
    };
    PreferencesUIStore?: {
      TabItem: new (options: {
        tabId: string;
        displayName: string;
        componentClassFn: () => { displayName?: string };
      }) => { tabId: string; displayName: string; componentClassFn: () => { displayName?: string } };
      registerPreferencesTab: (tab: {
        tabId: string;
        displayName: string;
        componentClassFn: () => { displayName?: string };
      }) => void;
      unregisterPreferencesTab: (tabId: string) => void;
    };
  };
  const originalRegistry = globalWithRegistry.ComponentRegistry;
  const originalExtensionRegistry = globalWithRegistry.ExtensionRegistry;
  const originalPreferencesUIStore = globalWithRegistry.PreferencesUIStore;
  const registeredComponents: Array<{ displayName?: string; role: string }> = [];
  const registeredMessageViewExtensions: Array<{ displayName?: string }> = [];
  const unregisteredMessageViewExtensions: Array<{ displayName?: string }> = [];
  const registeredTabs: Array<{ tabId: string; displayName: string; componentClassFn: () => { displayName?: string } }> = [];
  const unregisteredTabs: string[] = [];

  assert.equal(typeof plugin.activate, 'function', 'activate must be a function');
  assert.equal(typeof plugin.deactivate, 'function', 'deactivate must be a function');
  assert.equal(typeof plugin.serialize, 'function', 'serialize must be a function');
  assert.equal(typeof plugin.getManager, 'function', 'getManager must be a function');

  globalWithRegistry.ComponentRegistry = {
    register: (component, options) => {
      registeredComponents.push({ displayName: component.displayName, role: options.role });
    },
    unregister: () => {},
  };
  globalWithRegistry.ExtensionRegistry = {
    MessageView: {
      register: (extension) => registeredMessageViewExtensions.push(extension),
      unregister: (extension) => unregisteredMessageViewExtensions.push(extension),
    },
  };
  class TabItem {
    constructor(
      public readonly options: {
        tabId: string;
        displayName: string;
        componentClassFn: () => { displayName?: string };
      }
    ) {}

    get tabId() { return this.options.tabId; }
    get displayName() { return this.options.displayName; }
    get componentClassFn() { return this.options.componentClassFn; }
  }
  globalWithRegistry.PreferencesUIStore = {
    TabItem,
    registerPreferencesTab: (tab) => registeredTabs.push(tab),
    unregisterPreferencesTab: (tabId) => unregisteredTabs.push(tabId),
  };

  try {
    plugin.activate();
    const manager = plugin.getManager();
    assert.ok(manager, 'Manager instance should be active');

    assert.deepEqual(
      registeredComponents.map(({ displayName, role }) => ({ displayName, role })),
      [
        { displayName: 'MessageTranslatorHeader', role: 'message:BodyHeader' },
        { displayName: 'ComposerTranslatorButton', role: 'Composer:ActionButton' },
      ],
      'all registered React components must have a displayName'
    );
    assert.deepEqual(
      registeredMessageViewExtensions.map(({ displayName }) => displayName),
      ['OfflineTranslatorMessageViewExtension'],
      'message body formatter must be registered'
    );
    assert.equal(registeredTabs.length, 1, 'settings tab should be registered');
    assert.equal(registeredTabs[0].tabId, 'Offline Translator');
    assert.equal(registeredTabs[0].displayName, 'Offline Translator');
    assert.equal(
      registeredTabs[0].componentClassFn().displayName,
      'OfflineTranslatorSettingsTab',
      'settings tab must resolve to the named settings component'
    );

    const state = plugin.serialize();
    assert.ok(state && state.settings, 'serialize() should return serialized settings');

    plugin.deactivate();
    assert.equal(plugin.getManager(), null, 'Manager should be null after deactivation');
    assert.equal(unregisteredMessageViewExtensions.length, 1, 'message body formatter should be unregistered');
    assert.deepEqual(unregisteredTabs, ['Offline Translator'], 'settings tab should be unregistered');
  } finally {
    if (originalRegistry === undefined) {
      delete globalWithRegistry.ComponentRegistry;
    } else {
      globalWithRegistry.ComponentRegistry = originalRegistry;
    }
    if (originalExtensionRegistry === undefined) {
      delete globalWithRegistry.ExtensionRegistry;
    } else {
      globalWithRegistry.ExtensionRegistry = originalExtensionRegistry;
    }
    if (originalPreferencesUIStore === undefined) {
      delete globalWithRegistry.PreferencesUIStore;
    } else {
      globalWithRegistry.PreferencesUIStore = originalPreferencesUIStore;
    }
  }
});
