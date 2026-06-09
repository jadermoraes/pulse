import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { setBotToken, setBotUsername } from '$lib/server/telegram/config';

let db: DB;
vi.mock('$lib/server/db', async (orig) => {
  const real = (await orig()) as typeof import('$lib/server/db');
  return { ...real, getDb: () => db };
});

import { GET } from './+server';

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
});
afterEach(() => vi.clearAllMocks());

describe('GET /api/app/telegram/available', () => {
  it('returns enabled:false, botUsername:null when not configured', async () => {
    const body = await (await GET({} as any)).json();
    expect(body).toEqual({ enabled: false, botUsername: null });
  });

  it('returns enabled:true, botUsername when configured', async () => {
    setBotToken(db, 'fake:token');
    setBotUsername(db, 'pulsebot');
    const body = await (await GET({} as any)).json();
    expect(body).toEqual({ enabled: true, botUsername: 'pulsebot' });
  });

  it('returns enabled:false when only token is set (no username)', async () => {
    setBotToken(db, 'fake:token');
    const body = await (await GET({} as any)).json();
    expect(body).toEqual({ enabled: false, botUsername: null });
  });
});
