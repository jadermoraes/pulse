import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { setBotUsername } from '$lib/server/telegram/config';
import { bindChat } from '$lib/server/telegram/bindings';

let db: DB;
vi.mock('$lib/server/db', async (orig) => {
  const real = (await orig()) as typeof import('$lib/server/db');
  return { ...real, getDb: () => db };
});

import { GET } from './+server';

const withAdmin = () => ({ locals: { user: { id: 1 } } }) as any;
const noAdmin = () => ({ locals: {} }) as any;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
});
afterEach(() => vi.clearAllMocks());

describe('GET /api/telegram/status', () => {
  it('401 without admin session', async () => {
    await expect(GET(noAdmin())).rejects.toMatchObject({ status: 401 });
  });

  it('returns configured:false, adminBound:false when nothing set', async () => {
    const body = await (await GET(withAdmin())).json();
    expect(body).toEqual({ configured: false, adminBound: false });
  });

  it('returns configured:true when username is set', async () => {
    setBotUsername(db, 'pulsebot');
    const body = await (await GET(withAdmin())).json();
    expect(body).toEqual({ configured: true, adminBound: false });
  });

  it('returns adminBound:true when an admin binding exists', async () => {
    setBotUsername(db, 'pulsebot');
    bindChat(db, 11111, 'admin', 1, null);
    const body = await (await GET(withAdmin())).json();
    expect(body).toEqual({ configured: true, adminBound: true });
  });
});
