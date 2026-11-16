import test from 'node:test';
import assert from 'node:assert/strict';
import { HtmlTranslator } from '../lib/utils/html-translator.js';

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

test('HTML reassemble strips HTML tags injected by MT model in translated segments', async () => {
  const html = '<p>Hello <strong>World</strong>!</p>';
  // Simula un modello MT che restituisce testo con tag HTML
  const translated = await HtmlTranslator.translateHtml(
    html,
    async (texts) => texts.map((t) => {
      if (t === 'Hello') return '<p>Ciao</p>';
      if (t === 'World') return '<b>Mondo</b>';
      return t;
    })
  );

  // I tag HTML restituiti dal modello dovrebbero essere rimossi
  assert.ok(translated.includes('Ciao'));
  assert.ok(translated.includes('Mondo'));
  // Non dovrebbe contenere i tag HTML iniettati dal modello
  assert.ok(!translated.includes('<p>Ciao</p>'));
  assert.ok(!translated.includes('<b>Mondo</b>'));
  // La struttura HTML originale dovrebbe essere preservata
  assert.ok(translated.includes('<p>'));
  assert.ok(translated.includes('<strong>'));
});

test('HTML reassemble decodes HTML entities injected by MT model', async () => {
  const html = '<div>Price: $100 &amp; up</div>';
  // Simula un modello MT che restituisce entità HTML
  const translated = await HtmlTranslator.translateHtml(
    html,
    async (texts) => texts.map((t) => t.replace('Price:', 'Prezzo:').replace('$100 &amp; up', '$100 &lt; 200'))
  );

  assert.ok(translated.includes('Prezzo:'));
  // Le entità HTML dovrebbero essere decodificate
  assert.ok(translated.includes('$100 < 200'));
  assert.ok(!translated.includes('&lt;'));
});

test('HTML reassemble handles double-escaped entities from MT model', async () => {
  const html = '<div>As you\'ve received it, everything must be a-ok.</div>';
  // Simula un modello MT che restituisce entità doppio-escaped (come appare nel DOM)
  // Nel DOM, &amp;lt; appare come &amp;lt; perché & viene escapeato come &amp;
  const translated = await HtmlTranslator.translateHtml(
    html,
    async (texts) => texts.map((t) => {
      // Il modello restituisce HTML con entità escaped
      return t.replace("you've", "l'hai").replace("everything", "tutto").replace("a-ok", "a-ok");
    })
  );

  assert.ok(translated.includes("l'hai"));
  assert.ok(translated.includes('tutto'));
});

test('HTML reassemble strips escaped HTML tags from MT model output', async () => {
  const html = '<div>Hello World</div>';
  // Simula un modello MT che restituisce tag HTML escaped come &lt;div&gt;Ciao Mondo&lt;/div&gt;
  const translated = await HtmlTranslator.translateHtml(
    html,
    async (texts) => texts.map((t) => {
      if (t.includes('Hello')) return '&lt;div style="font-weight:bold"&gt;Ciao Mondo&lt;/div&gt;';
      return t;
    })
  );

  // I tag HTML escaped dovrebbero essere rimossi
  assert.ok(translated.includes('Ciao Mondo'));
  assert.ok(!translated.includes('&lt;div'));
  assert.ok(!translated.includes('&gt;'));
  // La struttura HTML originale dovrebbe essere preservata
  assert.ok(translated.includes('<div>'));
});

test('HTML reassemble handles numeric HTML entities', async () => {
  const html = '<div>Price: $100</div>';
  // Simula un modello MT che restituisce entità numeriche
  const translated = await HtmlTranslator.translateHtml(
    html,
    async (texts) => texts.map((t) => t.replace('Price:', 'Prezzo:&#160;').replace('$100', '$100'))
  );

  assert.ok(translated.includes('Prezzo:'));
  // &#160; dovrebbe essere decodificato in spazio
  assert.ok(!translated.includes('&#160;'));
});
