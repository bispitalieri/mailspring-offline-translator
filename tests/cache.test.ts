import test from 'node:test';
import assert from 'node:assert/strict';
import { TranslationCache, computeSha256 } from '../lib/cache';

test('SHA-256 generates deterministic 64-character hex digests', () => {
  const hash1 = computeSha256('Hello world');
  const hash2 = computeSha256('Hello world');
  const hash3 = computeSha256('Different string');

  assert.equal(hash1.length, 64);
  assert.equal(hash1, hash2);
  assert.notEqual(hash1, hash3);
});

test('TranslationCache stores, retrieves, and hits cache', () => {
  const cache = new TranslationCache(10, 24); // 10MB, 24h
  const key = cache.generateKey('Test message', 'en', 'it', 'argos');

  assert.equal(cache.get(key), null);

  cache.set(key, 'Messaggio di prova', 'en', 'it', 'argos');

  const retrieved = cache.get(key);
  assert.ok(retrieved !== null);
  assert.equal(retrieved.translatedText, 'Messaggio di prova');
  assert.equal(retrieved.sourceLang, 'en');
  assert.equal(retrieved.targetLang, 'it');

  const stats = cache.getStats();
  assert.equal(stats.entryCount, 1);
  assert.equal(stats.hitCount, 1);
  assert.equal(stats.missCount, 1);
});

test('TranslationCache clear purges all items and resets stats', () => {
  const cache = new TranslationCache(10, 24);
  const key1 = cache.generateKey('Text 1', 'en', 'it', 'argos');
  const key2 = cache.generateKey('Text 2', 'en', 'it', 'argos');

  cache.set(key1, 'Testo 1', 'en', 'it', 'argos');
  cache.set(key2, 'Testo 2', 'en', 'it', 'argos');

  assert.equal(cache.getStats().entryCount, 2);

  cache.clear();
  assert.equal(cache.getStats().entryCount, 0);
  assert.equal(cache.get(key1), null);
});
