import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  registerPending, getPending, resolvePending, expireStale, __resetPending
} from './confirm';

beforeEach(() => __resetPending());
afterEach(() => vi.useRealTimers());

describe('confirm pending store', () => {
  it('registers and retrieves a pending action by id', () => {
    const id = registerPending({ conversationId: 1, tool: 'runAction', args: { x: 1 }, summary: 'do it' });
    expect(typeof id).toBe('string');
    const p = getPending(id)!;
    expect(p.tool).toBe('runAction');
    expect(p.args).toEqual({ x: 1 });
  });

  it('resolvePending removes the entry and returns it once', () => {
    const id = registerPending({ conversationId: 1, tool: 'stopContainer', args: { id: 'c' }, summary: 's' });
    const taken = resolvePending(id)!;
    expect(taken.tool).toBe('stopContainer');
    expect(getPending(id)).toBeUndefined();   // single-use
    expect(resolvePending(id)).toBeUndefined();
  });

  it('expires entries older than the TTL without executing them', () => {
    vi.useFakeTimers();
    const id = registerPending({ conversationId: 1, tool: 'runAction', args: {}, summary: 's', ttlMs: 1000 });
    vi.advanceTimersByTime(1500);
    expireStale();
    expect(getPending(id)).toBeUndefined();
  });
});
