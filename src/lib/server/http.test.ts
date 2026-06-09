import { describe, it, expect, vi, afterEach } from 'vitest';
import { sendJsonWithKey } from './http';

afterEach(() => vi.restoreAllMocks());

describe('sendJsonWithKey', () => {
  it('sends the X-Api-Key header and method, never the key in the URL, parses JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => ({
      ok: true, status: 200, json: async () => ({ id: 5, ok: true })
    } as Response)));
    const out = await sendJsonWithKey('http://x/api/v1/request/5/approve', 'POST', 'KEY', { a: 1 });
    expect(out).toMatchObject({ id: 5 });
    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).not.toContain('KEY');
    expect(init.method).toBe('POST');
    expect((init.headers as any)['X-Api-Key']).toBe('KEY');
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it('omits the body when none is given and throws on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, json: async () => ({}) } as Response)));
    await expect(sendJsonWithKey('http://x/api/v3/command', 'POST', 'KEY')).rejects.toThrow('HTTP 409');
    const init = (fetch as any).mock.calls[0][1] as RequestInit;
    expect('body' in init).toBe(false);
  });

  it('treats 204 No Content as success with empty object', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 204, json: async () => { throw new Error('no body'); }
    } as unknown as Response)));
    const out = await sendJsonWithKey('http://x/api/v3/queue/1', 'DELETE', 'KEY');
    expect(out).toEqual({});
  });
});
