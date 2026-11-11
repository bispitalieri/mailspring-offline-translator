/**
 * BCP-47 Language Tag Normalizer & Locale Utilities
 */

const LANGUAGE_NAMES: Record<string, string> = {
  af: 'Afrikaans',
  ar: 'Arabic',
  bg: 'Bulgarian',
  ca: 'Catalan',
  cs: 'Czech',
  da: 'Danish',
  de: 'German',
  el: 'Greek',
  en: 'English',
  es: 'Spanish',
  et: 'Estonian',
  fa: 'Persian',
  fi: 'Finnish',
  fr: 'French',
  he: 'Hebrew',
  hi: 'Hindi',
  hr: 'Croatian',
  hu: 'Hungarian',
  id: 'Indonesian',
  it: 'Italian',
  ja: 'Japanese',
  ko: 'Korean',
  lt: 'Lithuanian',
  lv: 'Latvian',
  nl: 'Dutch',
  no: 'Norwegian',
  pl: 'Polish',
  pt: 'Portuguese',
  ro: 'Romanian',
  ru: 'Russian',
  sk: 'Slovak',
  sl: 'Slovenian',
  sv: 'Swedish',
  th: 'Thai',
  tr: 'Turkish',
  uk: 'Ukrainian',
  vi: 'Vietnamese',
  zh: 'Chinese',
};

export function normalizeLanguageTag(tag: string | null | undefined): string {
  if (!tag || typeof tag !== 'string') {
    return 'en';
  }

  let clean = tag.trim().split('.')[0].split('@')[0];
  clean = clean.replace(/_/g, '-');

  if (clean.toLowerCase().startsWith('zh')) {
    if (clean.toLowerCase().includes('hant') || clean.toLowerCase().includes('tw') || clean.toLowerCase().includes('hk')) {
      return 'zh-Hant';
    }
    return 'zh';
  }

  const primary = clean.split('-')[0].toLowerCase();
  if (/^[a-z]{2,3}$/.test(primary)) {
    return primary;
  }

  return 'en';
}

export function getSystemLocale(): string {
  if (typeof navigator !== 'undefined' && navigator.language) {
    return normalizeLanguageTag(navigator.language);
  }

  if (typeof process !== 'undefined' && process.env) {
    const envLang = process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG;
    if (envLang) {
      return normalizeLanguageTag(envLang);
    }
  }

  try {
    if (typeof Intl !== 'undefined' && Intl.DateTimeFormat) {
      const resolved = Intl.DateTimeFormat().resolvedOptions().locale;
      if (resolved) {
        return normalizeLanguageTag(resolved);
      }
    }
  } catch {
    // Ignore fallback
  }

  return 'en';
}

export function getLanguageDisplayName(code: string, displayInLocale = 'en'): string {
  const norm = normalizeLanguageTag(code);
  try {
    if (typeof Intl !== 'undefined' && (Intl as any).DisplayNames) {
      const dn = new (Intl as any).DisplayNames([displayInLocale, 'en'], { type: 'language' });
      const name = dn.of(norm);
      if (name) return name;
    }
  } catch {
    // Fallback to static table
  }

  return LANGUAGE_NAMES[norm] || norm.toUpperCase();
}

export function getCommonLanguages(): Array<{ code: string; name: string }> {
  return Object.entries(LANGUAGE_NAMES)
    .map(([code, name]) => ({ code, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
