import { describe, it, expect, afterEach, vi } from 'vitest';
import { plexAccountFromToken } from './plex-account';

afterEach(() => vi.restoreAllMocks());

describe('plexAccountFromToken', () => {
  it('resolves the account id + email from the token', async () => {
    let sawToken: string | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_u: any, init?: RequestInit) => {
      sawToken = (init?.headers as Record<string, string>)?.['X-Plex-Token'] ?? null;
      return new Response(JSON.stringify({ id: 777, email: 'ana@x.com' }), { status: 200 });
    }));
    const acct = await plexAccountFromToken('plex-tok');
    expect(acct.id).toBe('777');
    expect(acct.email).toBe('ana@x.com');
    expect(sawToken).toBe('plex-tok');
  });

  it('throws a precise error on failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    await expect(plexAccountFromToken('bad')).rejects.toThrow(/plex|HTTP 401/i);
  });
});
