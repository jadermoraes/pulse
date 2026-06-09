import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';

let db: DB;
vi.mock('$lib/server/db', async (orig) => {
  const real = (await orig()) as typeof import('$lib/server/db');
  return { ...real, getDb: () => db };
});

import { GET, PUT } from './+server';

const withAdmin = (id = 1) => ({ locals: { user: { id } } }) as any;
const noAdmin = () => ({ locals: {} }) as any;
const putReq = (body: unknown, user: unknown = { id: 1 }) =>
  PUT({
    request: new Request('http://x', { method: 'PUT', body: JSON.stringify(body) }),
    locals: { user }
  } as any);

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
});
afterEach(() => vi.clearAllMocks());

describe('GET /api/telegram/prefs', () => {
  it('401 without admin session', async () => {
    await expect(GET(noAdmin())).rejects.toMatchObject({ status: 401 });
  });

  it('returns default prefs (all true) when unset', async () => {
    const body = await (await GET(withAdmin())).json();
    expect(body).toEqual({
      prefs: { container_down: true, disk_high: true, download_stalled: true }
    });
  });
});

describe('PUT /api/telegram/prefs', () => {
  it('401 without admin session', async () => {
    await expect(putReq({ prefs: {} }, null)).rejects.toMatchObject({ status: 401 });
  });

  it('persists prefs; GET reflects the new values', async () => {
    const res = await putReq({ prefs: { container_down: false, disk_high: true, download_stalled: false } });
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.prefs).toEqual({ container_down: false, disk_high: true, download_stalled: false });

    const getBody = await (await GET(withAdmin())).json();
    expect(getBody).toEqual({
      prefs: { container_down: false, disk_high: true, download_stalled: false }
    });
  });

  it('defaults missing keys to true', async () => {
    // Only send container_down=false; other keys omitted → should default to true
    const res = await putReq({ prefs: { container_down: false } });
    const body = await res.json();
    expect(body.prefs).toEqual({ container_down: false, disk_high: true, download_stalled: true });
  });

  it('400 on invalid JSON body', async () => {
    await expect(
      PUT({
        request: new Request('http://x', { method: 'PUT', body: 'not-json' }),
        locals: { user: { id: 1 } }
      } as any)
    ).rejects.toMatchObject({ status: 400 });
  });
});
