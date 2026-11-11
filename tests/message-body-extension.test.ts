import test from 'node:test';
import assert from 'node:assert/strict';
import { formatWithPresentation, MessagePresentation } from '../src/message-body-extension';

function presentation(overrides: Partial<MessagePresentation> = {}): MessagePresentation {
  return {
    originalBody: '<p>Hello</p>',
    translatedBody: '<p>Ciao</p>',
    isPlaintext: false,
    mode: 'inline',
    ...overrides,
  };
}

test('message body formatter renders inline translated HTML', () => {
  const message = { id: 'html-inline', body: '<p>Hello</p>' };
  formatWithPresentation(message, presentation());
  assert.equal(message.body, '<p>Ciao</p>');
});

test('message body formatter renders side-by-side HTML without losing original', () => {
  const message = { id: 'html-split', body: '<p>Hello</p>' };
  formatWithPresentation(message, presentation({ mode: 'split' }));
  assert.match(message.body, /Original/);
  assert.match(message.body, /<p>Hello<\/p>/);
  assert.match(message.body, /<p>Ciao<\/p>/);
});

test('message body formatter escapes plaintext before rendering', () => {
  const message = { id: 'plain-inline', body: 'Hello <world>' };
  formatWithPresentation(
    message,
    presentation({
      originalBody: 'Hello <world>',
      translatedBody: 'Ciao <mondo>',
      isPlaintext: true,
    })
  );
  assert.equal(
    message.body,
    '<pre style="white-space: pre-wrap; overflow-wrap: anywhere">Ciao &lt;mondo&gt;</pre>'
  );
});
