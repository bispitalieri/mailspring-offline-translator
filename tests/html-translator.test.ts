import test from 'node:test';
import assert from 'node:assert/strict';
import { HtmlTranslator } from '../lib/html-translator';

test('HTML segmentation preserves tags, links, and formatting', async () => {
  const html = '<p>Hello <strong>World</strong>! Click <a href="https://example.com/login?id=42">here</a>.</p>';
  const { skeleton, segments } = HtmlTranslator.segment(html);

  assert.ok(skeleton.includes('<p>'));
  assert.ok(skeleton.includes('<strong>'));
  assert.ok(skeleton.includes('<a href="https://example.com/login?id=42">'));
  assert.ok(segments.length > 0);

  // Mock translation: convert English to Italian
  const translated = await HtmlTranslator.translateHtml(
    html,
    async (texts) => texts.map((t) => t.replace('Hello', 'Ciao').replace('World', 'Mondo').replace('here', 'qui'))
  );

  assert.ok(translated.includes('<p>'));
  assert.ok(translated.includes('Ciao'));
  assert.ok(translated.includes('Mondo'));
  assert.ok(translated.includes('<a href="https://example.com/login?id=42">'));
  assert.ok(translated.includes('qui</a>'));
});

test('HTML segmentation protects email addresses from translation', async () => {
  const html = '<div>Contact our lead at <a href="mailto:support@mailspring.com">support@mailspring.com</a> or admin@offline.org.</div>';
  const { skeleton, segments } = HtmlTranslator.segment(html);

  // Segments should mask the email or preserve mailto
  const translated = await HtmlTranslator.translateHtml(
    html,
    async (texts) => texts.map((t) => t.replace('Contact our lead at', 'Contatta il nostro responsabile a'))
  );

  assert.ok(translated.includes('mailto:support@mailspring.com'));
  assert.ok(translated.includes('support@mailspring.com'));
  assert.ok(translated.includes('admin@offline.org'));
  assert.ok(translated.includes('Contatta il nostro responsabile a'));
});

test('HTML segmentation preserves code blocks and pre tags when excluded', async () => {
  const html = '<div>Run this command: <pre><code>git checkout -b feature/offline</code></pre> to continue.</div>';
  const translated = await HtmlTranslator.translateHtml(
    html,
    async (texts) => texts.map((t) => t.replace('Run this command', 'Esegui questo comando').replace('to continue', 'per continuare')),
    { excludeCodeBlocks: true }
  );

  assert.ok(translated.includes('<code>git checkout -b feature/offline</code>'));
  assert.ok(translated.includes('Esegui questo comando'));
  assert.ok(translated.includes('per continuare'));
});

test('HTML segmentation excludes signatures and blockquotes when configured', async () => {
  const html = `
    <div>Ciao Mario, ecco il preventivo.</div>
    <div class="gmail_signature">-- <br>Ing. Biagio Spitalieri<br>CTO Mailspring Lab</div>
    <blockquote class="gmail_quote">Precedente messaggio inviato lunedì...</blockquote>
  `;

  const translated = await HtmlTranslator.translateHtml(
    html,
    async (texts) => texts.map((t) => t.replace('Ciao Mario, ecco il preventivo', 'Hello Mario, here is the quote')),
    { excludeSignatures: true, excludeQuotedReplies: true }
  );

  assert.ok(translated.includes('Hello Mario, here is the quote'));
  assert.ok(translated.includes('Ing. Biagio Spitalieri'));
  assert.ok(translated.includes('Precedente messaggio inviato lunedì'));
});
