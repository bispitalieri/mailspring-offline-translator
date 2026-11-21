#!/usr/bin/env node
//
//  edge-translator.js
//  Mailspring Offline Translator - Windows Edge Translator API Helper
//
//  Uses the Microsoft Edge / Chromium Translator API for native, on-device
//  offline translation. Communicates with Mailspring over stdin/stdout using
//  JSON Lines (same protocol as the Apple helper).
//
//  Requirements:
//    - Windows 10/11 with Microsoft Edge (Chromium) installed
//    - Edge 148+ for Translator API support (Chrome 138+ also supported)
//    - Node.js 18+
//
//  Architecture:
//    This helper spawns a headless Edge instance with remote debugging enabled,
//    then communicates via the Chrome DevTools Protocol (CDP) using raw
//    WebSocket (Node.js native). The Translator API runs inside the Edge page
//    context, providing offline translation with on-device models.
//
//  No external dependencies required - uses only Node.js built-in modules.
//

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { WebSocket } = require('ws');

// ---------------------------------------------------------------------------
//  IPC Protocol (matches Apple helper)
// ---------------------------------------------------------------------------

function sendJSONResponse(id, action, payload, error) {
  const resp = { id, action, payload, error };
  process.stdout.write(JSON.stringify(resp) + '\n');
}

function sendError(id, action, code, message) {
  sendJSONResponse(id, action, null, { code, message });
}

// ---------------------------------------------------------------------------
//  Edge / Chromium executable resolver
// ---------------------------------------------------------------------------

function findEdgeExecutable() {
  const candidates = [
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge Beta', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge Dev', 'Application', 'msedge.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'Edge SxS', 'Application', 'msedge.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch { /* skip */ }
  }
  return null;
}

// ---------------------------------------------------------------------------
//  Supported languages (Chrome/Edge Translator API)
// ---------------------------------------------------------------------------

const SUPPORTED_LANGUAGES = [
  'ar', 'bg', 'bn', 'cs', 'da', 'de', 'el', 'en', 'es', 'fi', 'fr', 'he',
  'hi', 'hr', 'hu', 'id', 'it', 'ja', 'kn', 'ko', 'lt', 'mr', 'nl', 'no',
  'pl', 'pt', 'ro', 'ru', 'sk', 'sl', 'sv', 'ta', 'te', 'th', 'tr', 'uk',
  'vi', 'zh', 'zh-Hant'
];

// ---------------------------------------------------------------------------
//  CDP Client - lightweight Chrome DevTools Protocol client
// ---------------------------------------------------------------------------

class CDPClient {
  constructor(wsUrl) {
    this.ws = null;
    this.wsUrl = wsUrl;
    this.sessionId = null;
    this.targetId = null;
    this.commandId = 0;
    this.pending = new Map();
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.on('open', () => resolve());
      this.ws.on('error', reject);
      this.ws.on('message', (data) => this._onMessage(data.toString()));
    });
  }

  _onMessage(raw) {
    const msg = JSON.parse(raw);
    const pending = this.pending.get(msg.id);
    if (pending) {
      this.pending.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || 'CDP error'));
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  async command(method, params = {}) {
    const id = ++this.commandId;
    const payload = { id, method, params: { ...params, sessionId: this.sessionId } };
    this.ws.send(JSON.stringify(payload));

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP command timeout: ${method}`));
      }, 30000);

      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timeout); resolve(r); },
        reject: (e) => { clearTimeout(timeout); reject(e); }
      });
    });
  }

  async createPage() {
    // Create a new target (page)
    const target = await this.command('Target.createTarget', { url: 'about:blank' });
    this.targetId = target.targetId;

    // Attach to the new target
    const attach = await this.command('Target.attachToTarget', {
      targetId: this.targetId,
      flatten: true
    });
    this.sessionId = attach.sessionId;

    return this.sessionId;
  }

  async evaluate(expression) {
    const result = await this.command('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    });

    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.text || 'JavaScript evaluation error');
    }
    return result.result.value;
  }

  async evaluateWithArgs(fnBody, ...args) {
    // Create a self-executing function with arguments
    const argsJson = args.map(a => JSON.stringify(typeof a === 'function' ? a.toString() : a)).join(', ');
    const expression = `(async function() { ${fnBody} })(${argsJson})`;
    return this.evaluate(expression);
  }

  async addScriptToEvaluateOnLoad(source) {
    await this.command('Page.addScriptToEvaluateOnNewDocument', {
      source: `(() => { ${source} })();`,
      worldName: 'translator-helper'
    });
  }

  close() {
    try {
      if (this.targetId) {
        this.command('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
      }
      if (this.ws) {
        this.ws.close();
      }
    } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
//  Edge Browser Manager
// ---------------------------------------------------------------------------

let edgeProcess = null;
let cdpClient = null;
let isInitialized = false;
let debugPort = 0;
let userDataDir = '';

// Translator API wrapper script injected into the page
const TRANSLATOR_SCRIPT = `
window.__translatorHelper = {
  checkAPI: function() {
    return typeof Translator !== 'undefined' && typeof Translator.create === 'function';
  },

  detectLanguage: async function(text) {
    if (typeof LanguageDetector === 'undefined' || !LanguageDetector.create) {
      return null;
    }
    try {
      const detector = await LanguageDetector.create();
      const result = await detector.detect(text);
      if (result && result.languages && result.languages.length > 0) {
        const lang = result.languages[0];
        return {
          language: lang.language || 'en',
          confidence: lang.confidence || 0.5,
          isReliable: (lang.confidence || 0) > 0.7
        };
      }
    } catch (e) { /* ignore */ }
    return null;
  },

  checkAvailability: async function(sourceLang, targetLang) {
    if (typeof Translator === 'undefined') return 'unavailable';
    try {
      return await Translator.availability({
        sourceLanguage: sourceLang,
        targetLanguage: targetLang
      });
    } catch (e) {
      return 'unavailable';
    }
  },

  translateText: async function(text, sourceLang, targetLang) {
    if (typeof Translator === 'undefined') {
      throw new Error('Translator API not available');
    }

    const availability = await Translator.availability({
      sourceLanguage: sourceLang,
      targetLanguage: targetLang
    });

    if (availability === 'unavailable') {
      throw new Error('Language pair ' + sourceLang + ' -> ' + targetLang + ' not supported');
    }

    const session = await Translator.create({
      sourceLanguage: sourceLang,
      targetLanguage: targetLang
    });

    try {
      return await session.translate(text);
    } finally {
      try { session.destroy(); } catch(e) {}
    }
  }
};
`;

async function ensureBrowser() {
  if (isInitialized && cdpClient && cdpClient.ws && cdpClient.ws.readyState === 1) {
    return cdpClient;
  }

  const edgeExe = findEdgeExecutable();
  if (!edgeExe) {
    throw new Error('Microsoft Edge (Chromium) not found on this system');
  }

  // Find an available port
  debugPort = await findAvailablePort(9222, 9500);
  userDataDir = path.join(os.tmpdir(), 'mailspring-edge-translator-' + Date.now());
  fs.mkdirSync(userDataDir, { recursive: true });

  // Spawn Edge with remote debugging
  edgeProcess = spawn(edgeExe, [
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-translate',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-hang-monitor',
    '--disable-prompt-on-repost',
    '--metrics-recording-only',
    '--safebrowsing-disable-auto-update',
    '--password-store=basic',
    '--headless=new',
    'about:blank'
  ], {
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });

  // Wait for CDP to be ready
  const wsUrl = await waitForCDP(debugPort, 15000);

  // Connect to CDP
  cdpClient = new CDPClient(wsUrl);
  await cdpClient.connect();
  await cdpClient.createPage();

  // Inject the translator helper script
  await cdpClient.addScriptToEvaluateOnLoad(TRANSLATOR_SCRIPT);

  // Navigate to a blank page to trigger script injection
  await cdpClient.command('Page.navigate', { url: 'about:blank' });

  isInitialized = true;
  return cdpClient;
}

async function findAvailablePort(start, end) {
  for (let port = start; port <= end; port++) {
    try {
      await new Promise((resolve, reject) => {
        const server = require('net').createServer();
        server.listen(port, '127.0.0.1', () => {
          server.once('close', resolve);
          server.close();
        });
        server.on('error', () => reject(new Error(`Port ${port} in use`)));
      });
      return port;
    } catch { /* port in use, try next */ }
  }
  throw new Error('No available port found');
}

function waitForCDP(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Edge failed to start')), timeoutMs);
    const checkInterval = setInterval(() => {
      http.get(`http://127.0.0.1:${port}/json/version`, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          try {
            const info = JSON.parse(data);
            if (info.webSocketDebuggerUrl) {
              clearInterval(checkInterval);
              clearTimeout(timeout);
              resolve(info.webSocketDebuggerUrl);
            }
          } catch { /* parse error, retry */ }
        });
      }).on('error', () => { /* connection refused, retry */ });
    }, 200);
  });
}

// ---------------------------------------------------------------------------
//  Request handler
// ---------------------------------------------------------------------------

async function handleRequest(req) {
  const { id, action, payload } = req;

  try {
    switch (action) {
      case 'ping': {
        sendJSONResponse(id, 'ping', {
          status: 'ok',
          version: '1.0.0',
          provider: 'edge-translator'
        }, null);
        break;
      }

      case 'status': {
        const edgeExe = findEdgeExecutable();
        sendJSONResponse(id, 'status', {
          available: edgeExe ? 'true' : 'false',
          os: 'Windows 10/11',
          provider: 'edge-translator',
          edgePath: edgeExe || 'not found'
        }, null);
        break;
      }

      case 'list_languages': {
        const pairs = [];
        for (const src of SUPPORTED_LANGUAGES) {
          for (const tgt of SUPPORTED_LANGUAGES) {
            if (src !== tgt) {
              pairs.push({
                source: src,
                target: tgt,
                installed: true,
                providerId: 'edge-translator'
              });
            }
          }
        }
        sendJSONResponse(id, 'list_languages', pairs, null);
        break;
      }

      case 'detect': {
        const text = (payload && payload.text) || '';
        try {
          const client = await ensureBrowser();
          const result = await client.evaluateWithArgs(
            `async function(text) { return await window.__translatorHelper.detectLanguage(text); }`,
            text
          );

          if (result) {
            sendJSONResponse(id, 'detect', {
              language: result.language,
              confidence: result.confidence,
              isReliable: result.isReliable
            }, null);
          } else {
            sendJSONResponse(id, 'detect', {
              language: 'en',
              confidence: 0.5,
              isReliable: false
            }, null);
          }
        } catch (err) {
          sendError(id, 'detect', 'DETECTION_ERROR', err.message);
        }
        break;
      }

      case 'translate': {
        const text = (payload && payload.text) || '';
        let src = (payload && payload.sourceLang) || 'auto';
        const tgt = (payload && payload.targetLang) || 'en';

        try {
          const client = await ensureBrowser();
          const start = Date.now();

          // Auto-detect source language if needed
          if (src === 'auto') {
            const detection = await client.evaluateWithArgs(
              `async function(text) { return await window.__translatorHelper.detectLanguage(text); }`,
              text
            );
            src = (detection && detection.language) || 'en';
          }

          // Check availability
          const availability = await client.evaluateWithArgs(
            `async function(sourceLang, targetLang) { return await window.__translatorHelper.checkAvailability(sourceLang, targetLang); }`,
            src, tgt
          );

          if (availability === 'unavailable') {
            sendError(id, 'translate', 'UNSUPPORTED_PAIR',
              `Language pair ${src} -> ${tgt} is not supported by Edge Translator API`);
            return;
          }

          // Perform translation
          const translatedText = await client.evaluateWithArgs(
            `async function(text, sourceLang, targetLang) { return await window.__translatorHelper.translateText(text, sourceLang, targetLang); }`,
            text, src, tgt
          );

          const durationMs = Date.now() - start;
          sendJSONResponse(id, 'translate', {
            translatedText,
            detectedSourceLang: src,
            targetLang: tgt,
            durationMs
          }, null);
        } catch (err) {
          sendError(id, 'translate', 'TRANSLATION_ERROR', err.message);
        }
        break;
      }

      default:
        sendError(id, action, 'UNKNOWN_ACTION', `Action '${action}' is not recognized`);
    }
  } catch (err) {
    sendError(id, action, 'INTERNAL_ERROR', err.message);
  }
}

// ---------------------------------------------------------------------------
//  Stdin JSON Lines reader
// ---------------------------------------------------------------------------

function main() {
  let buffer = '';

  process.stdin.setEncoding('utf8');

  process.stdin.on('data', (chunk) => {
    buffer += chunk;

    while (buffer.includes('\n')) {
      const newlineIndex = buffer.indexOf('\n');
      const line = buffer.substring(0, newlineIndex).trim();
      buffer = buffer.substring(newlineIndex + 1);

      if (!line) continue;

      try {
        const req = JSON.parse(line);
        handleRequest(req).catch((err) => {
          console.error('[Edge Translator Helper] Unhandled error:', err);
        });
      } catch (err) {
        sendError('unknown', 'error', 'PARSE_ERROR',
          `Failed to parse JSON line: ${err.message}`);
      }
    }
  });

  process.stdin.on('end', cleanupAndExit);
  process.on('SIGINT', cleanupAndExit);
  process.on('SIGTERM', cleanupAndExit);
}

function cleanupAndExit() {
  if (cdpClient) {
    cdpClient.close();
    cdpClient = null;
  }

  if (edgeProcess && !edgeProcess.killed) {
    try { edgeProcess.kill('SIGTERM'); } catch { /* ignore */ }
  }

  // Clean up user data directory
  if (userDataDir) {
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  process.exit(0);
}

main();
