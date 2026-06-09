import { describe, it, expect, beforeAll } from 'vitest';
import { JSDOM } from 'jsdom';
import { markdownToHtml, renderMarkdown } from './markdown';

// The unit test env is `node`, so DOMPurify has no ambient DOM. Seed a jsdom window
// onto globalThis BEFORE the sanitizer is first built so renderMarkdown() exercises the
// real DOMPurify path (mirroring the browser). Must run before any renderMarkdown call.
beforeAll(() => {
  if (!(globalThis as { window?: unknown }).window) {
    (globalThis as { window?: unknown }).window = new JSDOM('').window;
  }
});

describe('markdownToHtml', () => {
  it('renders bold, tables, lists, blockquotes, and links', () => {
    const html = markdownToHtml(
      '**bold** _it_\n\n| # | Title |\n|---|---|\n| 1 | A |\n\n- one\n- two\n\n> quote\n\n[link](https://x.com)'
    );
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<table>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('href="https://x.com"');
  });

  it('renders inline code and fenced code blocks', () => {
    const html = markdownToHtml('use `npm` here\n\n```js\nconst a = 1;\n```');
    expect(html).toContain('<code>npm</code>');
    expect(html).toContain('<pre>');
  });
});

describe('renderMarkdown (sanitized)', () => {
  it('keeps safe markup: table, bold, list, blockquote', () => {
    const out = renderMarkdown('**hi**\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n- x\n\n> note');
    expect(out).toContain('<strong>hi</strong>');
    expect(out).toContain('<table>');
    expect(out).toContain('<li>x</li>');
    expect(out).toContain('<blockquote>');
  });

  it('opens links in a new tab with noopener', () => {
    const out = renderMarkdown('[go](https://example.com)');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('strips a <script> tag', () => {
    const out = renderMarkdown('hello <script>alert(1)</script> world');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
    expect(out).toContain('hello');
  });

  it('strips an onerror event handler from injected HTML', () => {
    const out = renderMarkdown('an image <img src="x" onerror="alert(1)"> here');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('alert(1)');
  });

  it('accepts an injectable sanitizer (parse step wired to sanitize step)', () => {
    const out = renderMarkdown('**b**', (h) => `SANITIZED:${h}`);
    expect(out.startsWith('SANITIZED:')).toBe(true);
    expect(out).toContain('<strong>b</strong>');
  });
});
