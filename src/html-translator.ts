/**
 * HTML Segmenter & Preserving Translator for Mailspring
 */

export interface HtmlSegmentationOptions {
  excludeSignatures?: boolean;
  excludeQuotedReplies?: boolean;
  excludeCodeBlocks?: boolean;
}

export interface SegmentedHtml {
  skeleton: string;
  segments: string[];
  inlineMasks: Map<string, string>;
}

export class HtmlTranslator {
  private static readonly EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
  private static readonly URL_REGEX = /https?:\/\/[^\s<>"']+/g;
  // Usa caratteri Unicode rari (Zero Width Space + U+FFFD) che i modelli MT tendono a preservare
  private static readonly MASK_PREFIX = '\u200B\uFFFD';
  private static readonly MASK_SUFFIX = '\uFFFD\u200B';

  public static segment(
    html: string,
    options: HtmlSegmentationOptions = {
      excludeSignatures: true,
      excludeQuotedReplies: true,
      excludeCodeBlocks: true,
    }
  ): SegmentedHtml {
    if (!html || typeof html !== 'string') {
      return { skeleton: '', segments: [], inlineMasks: new Map() };
    }

    const segments: string[] = [];
    const inlineMasks: Map<string, string> = new Map();
    let inlineId = 0;
    let skeleton = html;

    const scriptStyleTokens: Map<string, string> = new Map();
    let tokenIndex = 0;

    skeleton = skeleton.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, (match) => {
      const token = `<!--__OFFLINE_RAW_${tokenIndex++}__-->`;
      scriptStyleTokens.set(token, match);
      return token;
    });

    if (options.excludeCodeBlocks) {
      skeleton = skeleton.replace(/<(pre|code|kbd|samp)[^>]*>[\s\S]*?<\/\1>/gi, (match) => {
        const token = `<!--__OFFLINE_CODE_${tokenIndex++}__-->`;
        scriptStyleTokens.set(token, match);
        return token;
      });
    }

    if (options.excludeQuotedReplies) {
      skeleton = skeleton.replace(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/gi, (match) => {
        const token = `<!--__OFFLINE_QUOTE_${tokenIndex++}__-->`;
        scriptStyleTokens.set(token, match);
        return token;
      });

      skeleton = skeleton.replace(/<div\s+[^>]*class=["'][^"']*(gmail_quote|mailspring-quote|yahoo_quoted)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, (match) => {
        const token = `<!--__OFFLINE_QUOTE_${tokenIndex++}__-->`;
        scriptStyleTokens.set(token, match);
        return token;
      });
    }

    if (options.excludeSignatures) {
      skeleton = skeleton.replace(/<div\s+[^>]*class=["'][^"']*(gmail_signature|signature)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, (match) => {
        const token = `<!--__OFFLINE_SIG_${tokenIndex++}__-->`;
        scriptStyleTokens.set(token, match);
        return token;
      });
    }

    let segmentIndex = 0;
    const textNodePattern = />([^<]+)</g;

    skeleton = skeleton.replace(textNodePattern, (match, textContent) => {
      const trimmed = textContent.trim();
      if (!trimmed || /^[\s\d\p{P}]+$/u.test(trimmed)) {
        return match;
      }

      const leadingSpace = textContent.match(/^(\s*)/)?.[1] || '';
      const trailingSpace = textContent.match(/(\s*)$/)?.[1] || '';

      let maskedContent = trimmed;

      maskedContent = maskedContent.replace(HtmlTranslator.EMAIL_REGEX, (email: string) => {
        const mask = `${HtmlTranslator.MASK_PREFIX}EMAIL_${inlineId++}${HtmlTranslator.MASK_SUFFIX}`;
        inlineMasks.set(mask, email);
        return mask;
      });

      maskedContent = maskedContent.replace(HtmlTranslator.URL_REGEX, (url: string) => {
        const mask = `${HtmlTranslator.MASK_PREFIX}URL_${inlineId++}${HtmlTranslator.MASK_SUFFIX}`;
        inlineMasks.set(mask, url);
        return mask;
      });

      segments.push(maskedContent);
      const marker = `{{__SEG_${segmentIndex++}__}}`;

      return `>${leadingSpace}${marker}${trailingSpace}<`;
    });

    if (!/<[^>]+>/.test(skeleton)) {
      let trimmed = skeleton.trim();
      if (trimmed) {
        trimmed = trimmed.replace(HtmlTranslator.EMAIL_REGEX, (email: string) => {
          const mask = `${HtmlTranslator.MASK_PREFIX}EMAIL_${inlineId++}${HtmlTranslator.MASK_SUFFIX}`;
          inlineMasks.set(mask, email);
          return mask;
        });
        trimmed = trimmed.replace(HtmlTranslator.URL_REGEX, (url: string) => {
          const mask = `${HtmlTranslator.MASK_PREFIX}URL_${inlineId++}${HtmlTranslator.MASK_SUFFIX}`;
          inlineMasks.set(mask, url);
          return mask;
        });
        segments.push(trimmed);
        skeleton = `{{__SEG_${segmentIndex++}__}}`;
      }
    }

    for (const [token, original] of scriptStyleTokens.entries()) {
      skeleton = skeleton.replace(token, original);
    }

    return { skeleton, segments, inlineMasks };
  }

  public static reassemble(
    skeleton: string,
    translatedSegments: string[],
    inlineMasks?: Map<string, string>
  ): string {
    let result = skeleton;

    translatedSegments.forEach((translated, index) => {
      const marker = `{{__SEG_${index}__}}`;
      result = result.replace(marker, () => translated);
    });

    if (inlineMasks && inlineMasks.size > 0) {
      for (const [mask, original] of inlineMasks.entries()) {
        // Prova prima il placeholder originale
        result = result.replaceAll(mask, original);
        // I modelli MT possono modificare i placeholder; cerca varianti comuni
        // Il modello potrebbe aver rimosso gli zeri width space o aggiunto spazi
        const maskWithoutZwsp = mask.replace(/\u200B/g, '');
        result = result.replaceAll(maskWithoutZwsp, original);
        // Il modello potrebbe aver tradotto "URL" o "EMAIL" in altre lingue
        result = result.replace(/\uFFFD(?:tradotto|translated)?\s*(?:URL|url|URL_)[\d_]+\uFFFD/gi, original);
      }
    }

    return result;
  }

  public static async translateHtml(
    html: string,
    translatorFn: (texts: string[]) => Promise<string[]>,
    options?: HtmlSegmentationOptions
  ): Promise<string> {
    const { skeleton, segments, inlineMasks } = HtmlTranslator.segment(html, options);

    if (segments.length === 0) {
      return html;
    }

    const translatedSegments = await translatorFn(segments);
    return HtmlTranslator.reassemble(skeleton, translatedSegments, inlineMasks);
  }
}
