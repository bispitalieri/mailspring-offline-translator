/**
 * Local Offline Translation Cache
 */

import { CacheEntry, CacheStats } from './types';

export function computeSha256(text: string): string {
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    try {
      const nodeCrypto = require('crypto');
      return nodeCrypto.createHash('sha256').update(text, 'utf8').digest('hex');
    } catch {
      // Fallback
    }
  }

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    h0 = (h0 ^ (code * 31 + i)) | 0;
    h1 = (h1 ^ (code * 37 + (h0 >>> 3))) | 0;
    h2 = (h2 ^ (code * 41 + (h1 >>> 5))) | 0;
    h3 = (h3 ^ (code * 43 + (h2 >>> 7))) | 0;
    h4 = (h4 ^ (code * 47 + (h3 >>> 9))) | 0;
    h5 = (h5 ^ (code * 53 + (h4 >>> 11))) | 0;
    h6 = (h6 ^ (code * 59 + (h5 >>> 13))) | 0;
    h7 = (h7 ^ (code * 61 + (h6 >>> 15))) | 0;
  }

  const toHex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return `${toHex(h0)}${toHex(h1)}${toHex(h2)}${toHex(h3)}${toHex(h4)}${toHex(h5)}${toHex(h6)}${toHex(h7)}`;
}

export class TranslationCache {
  private entries: Map<string, CacheEntry> = new Map();
  private maxSizeBytes: number;
  private ttlMs: number;
  private hitCount = 0;
  private missCount = 0;
  private storageKey = 'mailspring_offline_translator_cache';

  constructor(maxSizeMB = 50, ttlHours = 720) {
    this.maxSizeBytes = maxSizeMB * 1024 * 1024;
    this.ttlMs = ttlHours * 60 * 60 * 1000;
    this.loadFromStorage();
  }

  public generateKey(
    text: string,
    sourceLang: string,
    targetLang: string,
    providerId: string,
    modelVersion = '1.0'
  ): string {
    const textHash = computeSha256(text);
    return `${providerId}:${modelVersion}:${sourceLang}->${targetLang}:${textHash}`;
  }

  public get(key: string): CacheEntry | null {
    const entry = this.entries.get(key);
    if (!entry) {
      this.missCount++;
      return null;
    }

    const now = Date.now();
    if (now - entry.createdAt > this.ttlMs) {
      this.entries.delete(key);
      this.missCount++;
      return null;
    }

    entry.lastAccessedAt = now;
    this.hitCount++;
    return entry;
  }

  public set(
    key: string,
    translatedText: string,
    sourceLang: string,
    targetLang: string,
    providerId: string
  ): void {
    const now = Date.now();
    const sizeBytes = (key.length + translatedText.length) * 2;

    this.evictIfNeeded(sizeBytes);

    const entry: CacheEntry = {
      hash: key,
      sourceLang,
      targetLang,
      providerId,
      translatedText,
      createdAt: now,
      lastAccessedAt: now,
      sizeBytes,
    };

    this.entries.set(key, entry);
    this.saveToStorage();
  }

  public clear(): void {
    this.entries.clear();
    this.hitCount = 0;
    this.missCount = 0;
    this.saveToStorage();
  }

  public getStats(): CacheStats {
    let totalSizeBytes = 0;
    for (const entry of this.entries.values()) {
      totalSizeBytes += entry.sizeBytes;
    }

    return {
      entryCount: this.entries.size,
      totalSizeBytes,
      hitCount: this.hitCount,
      missCount: this.missCount,
    };
  }

  private evictIfNeeded(additionalBytes: number): void {
    let currentSize = 0;
    for (const entry of this.entries.values()) {
      currentSize += entry.sizeBytes;
    }

    if (currentSize + additionalBytes <= this.maxSizeBytes) {
      return;
    }

    const sorted = Array.from(this.entries.entries()).sort(
      (a, b) => a[1].lastAccessedAt - b[1].lastAccessedAt
    );

    for (const [k, entry] of sorted) {
      this.entries.delete(k);
      currentSize -= entry.sizeBytes;
      if (currentSize + additionalBytes <= this.maxSizeBytes) {
        break;
      }
    }
  }

  private loadFromStorage(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        const raw = localStorage.getItem(this.storageKey);
        if (raw) {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            const now = Date.now();
            parsed.forEach((item: CacheEntry) => {
              if (item && item.hash && now - item.createdAt < this.ttlMs) {
                this.entries.set(item.hash, item);
              }
            });
          }
        }
      }
    } catch {
      // Storage unavailable or corrupted
    }
  }

  private saveToStorage(): void {
    try {
      if (typeof localStorage !== 'undefined') {
        const array = Array.from(this.entries.values()).slice(-200);
        localStorage.setItem(this.storageKey, JSON.stringify(array));
      }
    } catch {
      // Ignore quota exceptions
    }
  }
}
