import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProcessManager } from '../lib/process-manager';

test('ProcessManager stores models inside the plugin directory in Electron renderer', async () => {
  const pluginDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mailspring-plugin-'));
  const previousRoot = ProcessManager.getPluginRootDir();
  const previousWindow = (globalThis as any).window;

  try {
    ProcessManager.setPluginRootDir(pluginDir);
    (globalThis as any).window = { document: {} };

    const modelsDir = ProcessManager.getModelsDirectory();
    assert.equal(modelsDir, path.join(pluginDir, 'data', 'models'));
    assert.ok(fs.existsSync(modelsDir), 'Models directory should be created recursively');
  } finally {
    ProcessManager.setPluginRootDir(previousRoot);
    if (previousWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = previousWindow;
    }
    await fs.promises.rm(pluginDir, { recursive: true, force: true });
  }
});

test('ProcessManager resolves Apple executable with macOS requirement check', () => {
  const resolution = ProcessManager.resolveAppleExecutable();
  assert.ok(resolution, 'Apple resolution object should exist');
  if (process.platform !== 'darwin') {
    assert.equal(resolution.canExecute, false, 'Apple translation should not be executable on non-macOS');
    assert.ok(resolution.error?.includes('macOS'), 'Should describe macOS availability requirement');
  }
});
