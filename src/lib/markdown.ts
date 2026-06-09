/**
 * Render assistant chat text as sanitized HTML.
 *
 * Assistant replies arrive as Markdown (tables, bold, lists, blockquotes, code,
 * links). We parse with `marked` and sanitize with `DOMPurify` before handing the
 * result to `{@html}` — tool results can contain user-service data (media titles),
 * so unsanitized HTML would be an XSS vector.
 *
 * The sanitizer needs a DOM `window`. In the browser that's `globalThis.window`; in
 * node-based unit tests the test seeds a jsdom window onto `globalThis` (see
 * markdown.test.ts). We never statically import jsdom here so it stays out of the
 * browser bundle.
 */
import { marked } from 'marked';
import DOMPurify from 'dompurify';

type Sanitizer = { sanitize: (dirty: string) => string };

let cached: Sanitizer | null = null;

/** Build (once) a DOMPurify instance bound to the ambient window, with a hook that
 * forces external links to open safely in a new tab. */
function getSanitizer(): Sanitizer | null {
  if (cached) return cached;
  const win = (globalThis as { window?: unknown }).window;
  if (!win) return null;
  // DOMPurify's default export is itself a factory taking a window-like object
  // (works in the browser and in jsdom).
  const dp = DOMPurify(win as Window & typeof globalThis);
  dp.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.getAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
  cached = dp;
  return dp;
}

/** Parse Markdown to HTML (synchronously). Exposed for testing the parse step
 * independently of the DOM-dependent sanitize step. */
export function markdownToHtml(text: string): string {
  return marked.parse(text ?? '', { async: false, gfm: true, breaks: true }) as string;
}

/**
 * Parse `text` as Markdown and return sanitized HTML safe for `{@html}`.
 *
 * @param sanitize Optional override for the sanitize step. Defaults to a DOMPurify
 *   instance bound to the ambient window. If no window and no override are available,
 *   the (already-parsed) HTML is returned with raw `<script>`/event-handler markup
 *   stripped by a conservative fallback so we never emit obviously-dangerous output.
 */
export function renderMarkdown(text: string, sanitize?: (html: string) => string): string {
  const html = markdownToHtml(text);
  if (sanitize) return sanitize(html);
  const dp = getSanitizer();
  if (dp) return dp.sanitize(html);
  return fallbackStrip(html);
}

/** Last-resort sanitize when no DOM is available (should not happen in the browser
 * or in tests that seed a window). Strips script/style elements and on*-handlers. */
function fallbackStrip(html: string): string {
  return html
    .replace(/<\s*(script|style)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
}
