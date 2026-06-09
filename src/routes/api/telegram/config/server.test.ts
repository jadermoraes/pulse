import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';

let db: DB;
vi.mock('$lib/server/db', async (orig) => {
  const real = (await orig()) as typeof import('$lib/server/db');
  return { ...real, getDb: () => db };
});

vi.mock('$lib/server/telegram/api', () => ({
  tgGetMe: vi.fn()
}));

import { GET, PUT } from './+server';
import { tgGetMe } from '$lib/server/telegram/api';

const withAdmin = (id = 1) => ({ locals: { user: { id } } }) as any;
const noAdmin = () => ({ locals: {} }) as any;
const putReq = (body: unknown, user: unknown = { id: 1 }) =>
  PUT({ request: new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }), locals: { user } } as any);

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  vi.mocked(tgGetMe).mockResolvedValue({ id: 1, username: 'pulsebot' });
});
afterEach(() => vi.clearAllMocks());

describe('GET /api/telegram/config', () => {
  it('401 without admin session', async () => {
    await expect(GET(noAdmin())).rejects.toMatchObject({ status: 401 });
  });

  it('returns configured:false when no bot configured', async () => {
    const body = await (await GET(withAdmin())).json();
    expect(body).toEqual({ configured: false, botUsername: null });
  });
});

describe('PUT /api/telegram/config', () => {
  it('401 without admin session', async () => {
    await expect(putReq({ token: 'abc' }, null)).rejects.toMatchObject({ status: 401 });
  });

  it('sets token and username, GET reflects configured:true', async () => {
    const res = await putReq({ token: '123:abc' });
    const body = await res.json();
    expect(body).toEqual({ ok: true, configured: true, botUsername: 'pulsebot' });
    expect(vi.mocked(tgGetMe)).toHaveBeenCalledWith('123:abc');

    const getBody = await (await GET(withAdmin())).json();
    expect(getBody).toEqual({ configured: true, botUsername: 'pulsebot' });
  });

  it('400 when tgGetMe throws (invalid token)', async () => {
    vi.mocked(tgGetMe).mockRejectedValue(new Error('Telegram error'));
    await expect(putReq({ token: 'bad:token' })).rejects.toMatchObject({ status: 400 });
  });

  it('clears config when empty token provided', async () => {
    // First set a token
    await putReq({ token: '123:abc' });
    // Then clear it
    const res = await putReq({ token: '' });
    const body = await res.json();
    expect(body).toEqual({ ok: true, configured: false });
    const getBody = await (await GET(withAdmin())).json();
    expect(getBody).toEqual({ configured: false, botUsername: null });
  });

  it('clears config when token is whitespace', async () => {
    await putReq({ token: '123:abc' });
    const res = await putReq({ token: '   ' });
    const body = await res.json();
    expect(body).toEqual({ ok: true, configured: false });
  });

  it('400 on invalid JSON body', async () => {
    await expect(
      PUT({ request: new Request('http://x', { method: 'PUT', body: 'not-json' }), locals: { user: { id: 1 } } } as any)
    ).rejects.toMatchObject({ status: 400 });
  });
});
