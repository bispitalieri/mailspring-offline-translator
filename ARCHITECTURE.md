# Mailspring Offline Translator: Architectural Specification

## System Overview

Mailspring Offline Translator provides private, on-device email translation embedded into Mailspring's message reader, email composer, and preferences pane.

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Mailspring Electron Host                        │
│                                                                        │
│  ┌───────────────────────┐  ┌──────────────────────┐  ┌─────────────┐  │
│  │ MessageTranslatorView │  │  ComposerTranslate   │  │ Preferences │  │
│  │(role: message:BodyHeader)│ │(role: Composer:ActionButton)││ UIStore tab│ │
│  └───────────┬───────────┘  └──────────┬───────────┘  └──────┬──────┘  │
│              │                         │                     │         │
│              └─────────────────────────┼─────────────────────┘         │
│                                        ▼                               │
│                         ┌─────────────────────────────┐                │
│                         │     TranslationManager      │                │
│                         └──────┬───────────────┬──────┘                │
│                                │               │                       │
│                   ┌────────────┴───┐       ┌───┴──────────┐            │
│                   │ HtmlTranslator │       │ SHA256 Cache │            │
│                   └────────────────┘       └──────────────┘            │
│                                                                        │
│              ┌──────────────────────────────────────────────┐          │
│              │            Provider Resolver Core            │          │
│              └───────┬──────────────┬──────────────┬────────┘          │
└──────────────────────┼──────────────┼──────────────┼───────────────────┘
                       │              │              │
        JSON Lines IPC │              │              │ JSON Lines IPC
        (stdin/stdout) │              │              │ (stdin/stdout)
                       ▼              ▼              ▼
              ┌────────────────┐  ┌───────┐  ┌────────────────┐
              │ Apple Helper   │  │ WinAI │  │  Argos Worker  │
              │ (Swift 6 /     │  │ Probe │  │ (Python 3 /    │
              │  macOS 15)     │  │ (NPU) │  │  OpenNMT-py)   │
              └────────────────┘  └───────┘  └────────────────┘
```

---

## 1. Extension Points in Mailspring

Mailspring uses an internal `ComponentRegistry` inside its Electron renderer thread:

1. **`message:BodyHeader`**:
   - Injected directly into the email reading view.
   - Shows automatic language detection (`Italian → English`), provider identification badge (`Apple Translation`, `Argos Translate`), original vs. translated toggle, side-by-side split comparison, and instant language switcher.
   - **Database Invariant**: Never writes translated content to SQLite/IndexedDB (`MessageStore`). Only ephemeral UI state is rendered.

2. **`Composer:ActionButton`**:
   - Adds "Translate Draft" action icon next to formatting tools.
   - Triggers `ComposerTranslateModal` with side-by-side comparison.
   - Explicit confirmation required before replacing draft content.
   - Never sends emails automatically.

3. **`PreferencesUIStore`**:
   - Embedded into Mailspring's Preferences dialog.
   - Configures default target locale (`system` or BCP-47), provider preference, automatic fallback, display layout, signature/quote exclusion rules, and offline model management.

---

## 2. Safe HTML Translation Pipeline

Emails contain rich HTML, embedded styles, images, links, email addresses, and quoted reply headers. Translating raw HTML strings through machine translation engines corrupts tags (e.g. converting `href="test"` into `href="prova"` or altering tag capitalization).

`HtmlTranslator` guarantees tag safety through strict segmentation:

1. **Mask Non-Text Containers**:
   - `<script>`, `<style>`, `<noscript>`
   - `<code>`, `<pre>`, `<kbd>`, `<samp>`
   - Quoted replies (`blockquote`, `.gmail_quote`, `.mailspring-quote`)
   - Signatures (`.gmail_signature`, `-- `)
2. **Protect Inline Entities**:
   - Email addresses (e.g. `john.doe@domain.com`) are replaced with immutable tokens `{{EMAIL_N}}`.
   - Raw URLs are replaced with `{{URL_N}}`.
3. **Batch Translation**:
   - Only clean text nodes are translated.
4. **Reassembly**:
   - The original DOM / HTML skeleton is populated with translated text tokens, restoring URLs, emails, and container structures without running scripts.

---

## 3. IPC Protocol Specification (JSON Lines)

Communication with helper binaries runs strictly over standard input/output (`stdin`/`stdout`).

### Framing
Each message is a single-line UTF-8 JSON object terminated by a newline (`\n`). No binary buffers or raw HTTP sockets.

### Request Schema
```json
{
  "id": "req_1710000000_1",
  "action": "translate",
  "payload": {
    "text": "Buongiorno, allego il documento richiesto.",
    "sourceLang": "it",
    "targetLang": "en"
  }
}
```

### Response Schema
```json
{
  "id": "req_1710000000_1",
  "action": "translate",
  "payload": {
    "translatedText": "Good morning, I attach the requested document.",
    "detectedSourceLang": "it",
    "targetLang": "en",
    "durationMs": 42.5
  },
  "error": null
}
```

### Security & Privacy Controls
- **Request Correlation**: Each message is tagged with a unique request ID.
- **Timeouts**: Configurable timeout (default 15s) terminates hung requests.
- **Cancellation**: Mailspring can abort queued requests on message navigation.
- **Zero Logging**: Helpers strictly reject logging message bodies or user emails to stderr/stdout.

---

## 4. SHA-256 Translation Cache

To eliminate redundant inference when users re-open emails:
- **Key Formula**: `SHA-256(text) + ":" + sourceLang + "->" + targetLang + ":" + providerId`
- **Storage**: Local memory map backed by local storage.
- **Expiration**: Configurable TTL (default 30 days / 720 hours).
- **Eviction**: LRU (Least Recently Used) eviction enforced when storage threshold (50MB) is reached.
- **Privacy**: Local only. Never synchronized across network or cloud accounts.
