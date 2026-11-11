import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeLanguageTag, getLanguageDisplayName } from '../lib/bcp47';

test('BCP-47 normalizes region subtags to 2-letter ISO codes', () => {
  assert.equal(normalizeLanguageTag('it-IT'), 'it');
  assert.equal(normalizeLanguageTag('en-US'), 'en');
  assert.equal(normalizeLanguageTag('de-DE'), 'de');
  assert.equal(normalizeLanguageTag('fr-FR'), 'fr');
  assert.equal(normalizeLanguageTag('es-ES'), 'es');
});

test('BCP-47 cleans POSIX locale formats and charsets', () => {
  assert.equal(normalizeLanguageTag('it_IT.UTF-8'), 'it');
  assert.equal(normalizeLanguageTag('de_DE@euro'), 'de');
  assert.equal(normalizeLanguageTag('en_GB.iso88591'), 'en');
});

test('BCP-47 handles Chinese variants correctly', () => {
  assert.equal(normalizeLanguageTag('zh-CN'), 'zh');
  assert.equal(normalizeLanguageTag('zh-Hans'), 'zh');
  assert.equal(normalizeLanguageTag('zh-TW'), 'zh-Hant');
  assert.equal(normalizeLanguageTag('zh-Hant'), 'zh-Hant');
});

test('BCP-47 fallback on empty or invalid inputs', () => {
  assert.equal(normalizeLanguageTag(''), 'en');
  assert.equal(normalizeLanguageTag(null as any), 'en');
  assert.equal(normalizeLanguageTag(undefined as any), 'en');
  assert.equal(normalizeLanguageTag('12345'), 'en');
});

test('getLanguageDisplayName returns readable names', () => {
  assert.equal(getLanguageDisplayName('it'), 'Italian');
  assert.equal(getLanguageDisplayName('en'), 'English');
  assert.equal(getLanguageDisplayName('de'), 'German');
  assert.equal(getLanguageDisplayName('fr'), 'French');
});
