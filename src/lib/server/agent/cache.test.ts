import { describe, it, expect } from 'vitest';
import type { ModelMessage } from 'ai';
import { withHistoryCacheMarker, CACHE_OPTS } from './cache';

describe('withHistoryCacheMarker', () => {
  it('marks ONLY the last message with the anthropic cache breakpoint', () => {
    const messages: ModelMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' }
    ];
    const out = withHistoryCacheMarker(messages);
    expect((out[0] as any).providerOptions).toBeUndefined();
    expect((out[1] as any).providerOptions).toBeUndefined();
    expect((out[2] as any).providerOptions).toEqual(CACHE_OPTS);
  });

  it('returns an empty array unchanged', () => {
    expect(withHistoryCacheMarker([])).toEqual([]);
  });

  it('does not mutate the caller\'s messages', () => {
    const last: ModelMessage = { role: 'user', content: 'hi' };
    withHistoryCacheMarker([last]);
    expect((last as any).providerOptions).toBeUndefined();
  });

  it('preserves providerOptions a message already carries', () => {
    const messages = [
      { role: 'user', content: 'hi', providerOptions: { anthropic: { foo: 1 } } } as unknown as ModelMessage
    ];
    const out = withHistoryCacheMarker(messages);
    const opts = (out[0] as any).providerOptions.anthropic;
    expect(opts.foo).toBe(1);
    expect(opts.cacheControl).toEqual({ type: 'ephemeral' });
  });
});
