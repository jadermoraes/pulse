import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { setBotToken, setBotUsername } from '$lib/server/telegram/config';
import { consumeLinkToken } from '$lib/server/telegram/bindings';

let db: DB;
vi.mock('$lib/server/db', async (orig) => {
  const real = (await orig()) as typeof import('$lib/server/db');
  return { ...real, getDb: () => db };
});

import { POST } from './+server';

const withAdmin = (id = 42) => ({ locals: { user: { id } }, getClientAddress: () => '127.0.0.1' }) as any;
const noAdmin = () => ({ locals: {}, getClientAddress: () => '127.0.0.1' }) as any;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/telegram/link', () => {
  it('401 without admin session', async () => {
    await expect(POST(noAdmin())).rejects.toMatchObject({ status: 401 });
  });

  it('503 when telegram not configured', async () => {
    await expect(POST(withAdmin())).rejects.toMatchObject({ status: 503 });
  });

  it('mints an admin link token resolving to the admin user id', async () => {
    setBotToken(db, 'fake:token');
    setBotUsername(db, 'pulsebot');
    const res = await POST(withAdmin(42));
    const body = await res.json();
    expect(body.url).toMatch(/^https:\/\/t\.me\/pulsebot\?start=[0-9a-f]+$/);
    const token = new URL(body.url).searchParams.get('start')!;
    const result = consumeLinkToken(db, token);
    expect(result).toEqual({ kind: 'admin', subjectId: 42 });
  });
});
