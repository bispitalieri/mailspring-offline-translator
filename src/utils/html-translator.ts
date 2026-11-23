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
  // Uses rare Unicode characters (Zero Width Space + U+FFFD) that MT models tend to preserve
  private static readonly MASK_PREFIX = '\u200B\uFFFD';
  private static readonly MASK_SUFFIX = '\uFFFD\u200B';

  /**
   * Pre-processes HTML to exclude signatures, quotes, code blocks, and script/style
   * without segmenting text nodes. The result is HTML ready to be passed to Mz/Translate
   * with `html: true` which will natively preserve the structure.
   */
  public static preprocessHtml(
    html: string,
    options: HtmlSegmentationOptions = {
      excludeSignatures: true,
      excludeQuotedReplies: true,
      excludeCodeBlocks: true,
    }
  ): string {
    if (!html || typeof html !== 'string') {
      return html;
    }

    let processed = html;
    let tokenIndex = 0;

    // Preserve script and style blocks by replacing them with tokens
    const preservedBlocks: Map<string, string> = new Map();

    processed = processed.replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, (match) => {
      const token = `<!--__OFFLINE_RAW_${tokenIndex++}__-->`;
      preservedBlocks.set(token, match);
      return token;
    });

    // Exclude code blocks
    if (options.excludeCodeBlocks) {
      processed = processed.replace(/<(pre|code|kbd|samp)[^>]*>[\s\S]*?<\/\1>/gi, (match) => {
        const token = `<!--__OFFLINE_CODE_${tokenIndex++}__-->`;
        preservedBlocks.set(token, match);
        return token;
      });
    }

    // Exclude quotes and replies
    if (options.excludeQuotedReplies) {
      processed = processed.replace(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/gi, (match) => {
        const token = `<!--__OFFLINE_QUOTE_${tokenIndex++}__-->`;
        preservedBlocks.set(token, match);
        return token;
      });

      processed = processed.replace(/<div\s+[^>]*class=["'][^"']*(gmail_quote|mailspring-quote|yahoo_quoted)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, (match) => {
        const token = `<!--__OFFLINE_QUOTE_${tokenIndex++}__-->`;
        preservedBlocks.set(token, match);
        return token;
      });
    }

    // Exclude signatures
    if (options.excludeSignatures) {
      processed = processed.replace(/<div\s+[^>]*class=["'][^"']*(gmail_signature|signature)[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, (match) => {
        const token = `<!--__OFFLINE_SIG_${tokenIndex++}__-->`;
        preservedBlocks.set(token, match);
        return token;
      });
    }

    // Restore preserved blocks
    for (const [token, original] of preservedBlocks.entries()) {
      processed = processed.replace(token, original);
    }

    return processed;
  }

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

  /**
   * Removes HTML tags from translated text and decodes HTML entities.
   * MT models may return text with HTML tags (e.g., <p>, <br>, <b>)
   * or HTML entities (e.g., &lt;, &amp;) that should not be present in plain text segments.
   * Also handles double-escaped entities (e.g., &amp;lt; which appears as &lt; in the DOM).
   */
  private static stripHtmlTags(text: string): string {
    // First decode double-escaped entities (e.g., &amp;lt; -> &lt;, &amp;gt; -> &gt;)
    // This is necessary because when text is re-inserted into the DOM, existing entities
    // get escaped again, creating double-escaped entities.
    let stripped = text.replace(/&amp;lt;/gi, '&lt;').replace(/&amp;gt;/gi, '&gt;');
    stripped = stripped.replace(/&amp;amp;/gi, '&amp;').replace(/&amp;quot;/gi, '&quot;');
    stripped = stripped.replace(/&amp;#39;/gi, '&#39;').replace(/&amp;nbsp;/gi, '&nbsp;');

    // Remove all HTML tags (opening and closing), including escaped ones like &lt;div&gt;
    stripped = stripped.replace(/<[^>]*>/g, '');
    // Remove escaped HTML tags that the model may have introduced
    stripped = stripped.replace(/&lt;\/?[a-zA-Z][^&]*&gt;/gi, '');

    // Decode common HTML entities that the model may have introduced
    stripped = stripped.replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    stripped = stripped.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    stripped = stripped.replace(/&nbsp;/g, ' ');

    // Decode numeric entities (e.g., &#39; -> ', &#160; -> space)
    stripped = stripped.replace(/&#(\d+);/g, (_, decimal) => String.fromCharCode(parseInt(decimal, 10)));
    stripped = stripped.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

    return stripped;
  }

  public static reassemble(
    skeleton: string,
    translatedSegments: string[],
    inlineMasks?: Map<string, string>
  ): string {
    let result = skeleton;

    translatedSegments.forEach((translated, index) => {
      // Strip HTML tags from translated text to prevent them from being injected into the skeleton
      const cleaned = HtmlTranslator.stripHtmlTags(translated);
      const marker = `{{__SEG_${index}__}}`;
      result = result.replace(marker, () => cleaned);
    });

    if (inlineMasks && inlineMasks.size > 0) {
      for (const [mask, original] of inlineMasks.entries()) {
        // Try the original placeholder first
        result = result.replaceAll(mask, original);
        // MT models may modify placeholders; look for common variants
        // The model may have removed zero-width spaces or added spaces
        const maskWithoutZwsp = mask.replace(/\u200B/g, '');
        result = result.replaceAll(maskWithoutZwsp, original);
        // The model may have translated "URL" or "EMAIL" to other languages
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
