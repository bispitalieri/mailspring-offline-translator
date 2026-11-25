import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatMessageBody,
  formatWithPresentation,
  getMessageTranslationSource,
  htmlToPlaintext,
} from '../src/ui/message-body-extension';

interface MessagePresentation {
  originalBody: string;
  translatedBody: string;
  isPlaintext: boolean;
  mode: 'inline' | 'split' | 'original';
}

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
    '<div style="white-space: pre-wrap; overflow-wrap: anywhere">Ciao &lt;mondo&gt;</div>'
  );
});

test('message body formatter identifies plaintext from the inbox wrapper', () => {
  const message = { id: 'plain-wrapper', body: '<div id="inbox-plain-wrapper">Hello</div>' };
  formatMessageBody(message);
  assert.equal(getMessageTranslationSource(message).isPlaintext, true);
});

test('message body formatter identifies HTML from the inbox wrapper', () => {
  const message = {
    id: 'html-wrapper',
    body: '<div id="inbox-html-wrapper"><p>Hello</p></div>',
    plaintext: true,
  };
  formatMessageBody(message);
  assert.equal(getMessageTranslationSource(message).isPlaintext, false);
});

test('htmlToPlaintext converts br tags to newlines', () => {
  const html = 'This is an email.<br><br>As you\'ve received it, everything must be a-ok.<br><br>Kind regards,<br>The Mailspring Team';
  const result = htmlToPlaintext(html);
  assert.equal(result, 'This is an email.\n\nAs you\'ve received it, everything must be a-ok.\n\nKind regards,\nThe Mailspring Team');
});

test('htmlToPlaintext removes other HTML tags and decodes entities', () => {
  const html = 'Hello <strong>World</strong> &amp; friends<br/>See you <b>soon</b>!';
  const result = htmlToPlaintext(html);
  assert.equal(result, 'Hello World & friends\nSee you soon!');
});

test('htmlToPlaintext decodes numeric HTML entities', () => {
  const html = 'It&#39;s working&nbsp;fine<br>Line 2';
  const result = htmlToPlaintext(html);
  assert.equal(result, 'It\'s working fine\nLine 2');
});

test('asPlaintextHtml preserves newlines as br tags', () => {
  const message = { id: 'plain-newlines', body: 'Line 1\nLine 2' };
  formatWithPresentation(
    message,
    presentation({
      originalBody: 'Line 1\nLine 2',
      translatedBody: 'Line 1\nLine 2',
      isPlaintext: true,
    })
  );
  assert.ok(message.body.includes('<br>'));
  assert.ok(message.body.includes('Line 1'));
  assert.ok(message.body.includes('Line 2'));
});

test('asPlaintextHtml does not duplicate line breaks after br tags', () => {
  const message = { id: 'plain-single-newlines', body: 'Line 1\nLine 2' };
  formatWithPresentation(
    message,
    presentation({
      originalBody: 'Line 1\nLine 2',
      translatedBody: 'Line 1\nLine 2',
      isPlaintext: true,
    })
  );
  assert.equal(
    message.body,
    '<div style="white-space: pre-wrap; overflow-wrap: anywhere">Line 1<br>Line 2</div>'
  );
});
