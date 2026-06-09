import { describe, it, expect } from 'vitest';
import { modelMessageText } from './agent-message';

describe('modelMessageText', () => {
  it('extracts a USER message (string body) — the regression that dropped them', () => {
    expect(modelMessageText({ content: { role: 'user', content: 'hi there' } })).toBe('hi there');
  });

  it('extracts an ASSISTANT message (array of parts, text only)', () => {
    expect(
      modelMessageText({
        content: { role: 'assistant', content: [{ type: 'text', text: 'hello ' }, { type: 'tool-call', toolName: 'x' }, { type: 'text', text: 'world' }] }
      })
    ).toBe('hello world');
  });

  it('handles a plain-string content (older rows)', () => {
    expect(modelMessageText({ content: 'plain' })).toBe('plain');
  });

  it('handles a { text } body shape', () => {
    expect(modelMessageText({ content: { role: 'assistant', content: { text: 'inline' } } })).toBe('inline');
  });

  it('returns empty for tool-only / non-text bodies and bad input', () => {
    expect(modelMessageText({ content: { role: 'tool', content: [{ type: 'tool-result', toolName: 'x' }] } })).toBe('');
    expect(modelMessageText({})).toBe('');
    expect(modelMessageText(null)).toBe('');
    expect(modelMessageText(undefined)).toBe('');
  });
});
