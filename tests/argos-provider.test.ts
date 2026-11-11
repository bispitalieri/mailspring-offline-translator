import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createRequire } from 'module';
import { ArgosTranslationProvider } from '../lib/providers/argos-provider';

const require = createRequire(import.meta.url);
const AdmZip = require('../node_modules/adm-zip');

const catalogEntry = {
  from_code: 'en',
  from_name: 'English',
  to_code: 'it',
  to_name: 'Italian',
  package_version: '1.0',
  package_size: 134217728,
  links: ['https://argos-net.com/translate-en_it-1_0.argosmodel'],
};

function createModelArchive(includeTraversal = false): Buffer {
  const archive = new AdmZip();
  archive.addFile('translate-en_it/model/model.bin', Buffer.from('model'));
  archive.addFile('translate-en_it/model/shared_vocabulary.txt', Buffer.from('<unk>\n'));
  archive.addFile('translate-en_it/sentencepiece.model', Buffer.from('sentencepiece'));
  if (includeTraversal) {
    archive.addFile('outside.txt', Buffer.from('outside'));
    archive.getEntry('outside.txt')!.entryName = '../outside.txt';
  }
  return archive.toBuffer();
}

function modelResponse(url: unknown, archive: Buffer): Response {
  const response = new Response(new Uint8Array(archive), {
    status: 200,
    headers: { 'content-length': String(archive.length) },
  });
  Object.defineProperty(response, 'url', { value: String(url) });
  return response;
}

test('Argos provider downloads, extracts and removes a native model package', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'argos-provider-'));
  const archive = createModelArchive();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes('index.json')) {
      return new Response(JSON.stringify([catalogEntry]), { status: 200 });
    }
    return modelResponse(input, archive);
  };

  try {
    const provider = new ArgosTranslationProvider(tempDir);
    const installer = new ArgosTranslationProvider(tempDir);
    const detectedLanguage = await provider.detectLanguage(
      'Ciao, come stai? Questa è una prova della lingua italiana.'
    );
    assert.equal(detectedLanguage.language, 'it');
    assert.equal(await provider.isAvailable(), false);
    const progress: number[] = [];
    assert.equal(
      await installer.installModel('en', 'it', (percent) => progress.push(percent)),
      true
    );
    assert.equal(
      await provider.isAvailable(),
      true,
      'provider instances in other Mailspring windows must detect newly installed models'
    );
    assert.deepEqual(await provider.getSupportedLanguages(), [{
      source: 'en',
      target: 'it',
      sourceName: 'English',
      targetName: 'Italian',
      installed: true,
      modelSizeMB: 128,
      providerId: 'argos',
    }]);
    assert.equal(
      await fs.promises.readFile(
        path.join(tempDir, 'data', 'models', 'en-it', 'translate-en_it', 'model', 'model.bin'),
        'utf8'
      ),
      'model'
    );
    const installedModelPath = path.join(
      tempDir,
      'data',
      'models',
      'en-it',
      'translate-en_it',
      'model'
    );
    assert.equal(await fs.promises.readFile(path.join(installedModelPath, 'config.json'), 'utf8'), '{}');
    assert.equal(await fs.promises.readFile(path.join(installedModelPath, 'source.spm'), 'utf8'), 'sentencepiece');
    assert.equal(await fs.promises.readFile(path.join(installedModelPath, 'target.spm'), 'utf8'), 'sentencepiece');
    assert.ok(progress.includes(100));
    assert.equal(await installer.removeModel('en', 'it'), true);
    assert.equal(await provider.isAvailable(), false);
    assert.deepEqual(await provider.getSupportedLanguages(), []);
    provider.dispose();
    installer.dispose();
  } finally {
    globalThis.fetch = originalFetch;
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('Argos provider rejects archive entries that escape the model directory', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'argos-provider-'));
  const archive = createModelArchive(true);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => String(input).includes('index.json')
    ? new Response(JSON.stringify([catalogEntry]), { status: 200 })
    : modelResponse(input, archive);

  try {
    const provider = new ArgosTranslationProvider(tempDir);
    await assert.rejects(provider.installModel('en', 'it'), /unsafe path/);
    await assert.rejects(fs.promises.access(path.join(tempDir, 'data', 'outside.txt')));
    provider.dispose();
  } finally {
    globalThis.fetch = originalFetch;
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});

test('Argos provider loads native dependencies when running in Electron renderer', async () => {
  const tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'argos-renderer-'));
  const previousWindow = (globalThis as any).window;
  (globalThis as any).window = { document: {} };

  try {
    const provider = new ArgosTranslationProvider(tempDir);
    assert.equal(await provider.isAvailable(), false);
    assert.match(
      provider.getInfo().unavailabilityReason || '',
      /No Argos models are installed/
    );
    provider.dispose();
  } finally {
    if (previousWindow === undefined) {
      delete (globalThis as any).window;
    } else {
      (globalThis as any).window = previousWindow;
    }
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  }
});
