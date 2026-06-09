import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import { setBotToken, setBotUsername } from '$lib/server/telegram/config';
import { consumeLinkToken, bindChat } from '$lib/server/telegram/bindings';

let db: DB;
vi.mock('$lib/server/db', async (orig) => {
  const real = (await orig()) as typeof import('$lib/server/db');
  return { ...real, getDb: () => db };
});

import { GET, POST, DELETE } from './+server';

const withConsumer = (id: number) =>
  ({ locals: { consumer: { id } } }) as any;
const noConsumer = () =>
  ({ locals: {} }) as any;

beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
});
afterEach(() => vi.clearAllMocks());

describe('POST /api/app/telegram/link', () => {
  it('401 without consumer session', async () => {
    await expect(POST(noConsumer())).rejects.toMatchObject({ status: 401 });
  });

  it('503 when telegram not configured', async () => {
    await expect(POST(withConsumer(7))).rejects.toMatchObject({ status: 503 });
  });

  it('returns t.me URL with valid token that resolves to consumer', async () => {
    setBotToken(db, 'fake:token');
    setBotUsername(db, 'pulsebot');
    const res = await POST(withConsumer(7));
    const body = await res.json();
    expect(body.url).toMatch(/^https:\/\/t\.me\/pulsebot\?start=[0-9a-f]+$/);
    expect(body.bound).toBe(false);
    // Extract token from URL and consume it
    const token = new URL(body.url).searchParams.get('start')!;
    const result = consumeLinkToken(db, token);
    expect(result).toEqual({ kind: 'consumer', subjectId: 7 });
  });

  it('bound is true when consumer already has a chat bound', async () => {
    setBotToken(db, 'fake:token');
    setBotUsername(db, 'pulsebot');
    bindChat(db, 99999, 'consumer', 7, null);
    const res = await POST(withConsumer(7));
    const body = await res.json();
    expect(body.bound).toBe(true);
  });
});

describe('GET /api/app/telegram/link', () => {
  it('401 without consumer session', async () => {
    await expect(GET(noConsumer())).rejects.toMatchObject({ status: 401 });
  });

  it('returns enabled:false when not configured', async () => {
    const body = await (await GET(withConsumer(7))).json();
    expect(body).toEqual({ enabled: false, bound: false });
  });

  it('returns enabled:true when configured', async () => {
    setBotToken(db, 'fake:token');
    setBotUsername(db, 'pulsebot');
    const body = await (await GET(withConsumer(7))).json();
    expect(body).toEqual({ enabled: true, bound: false });
  });

  it('returns bound:true when consumer has a binding', async () => {
    setBotToken(db, 'fake:token');
    setBotUsername(db, 'pulsebot');
    bindChat(db, 99999, 'consumer', 7, null);
    const body = await (await GET(withConsumer(7))).json();
    expect(body).toEqual({ enabled: true, bound: true });
  });
});

describe('DELETE /api/app/telegram/link', () => {
  it('401 without consumer session', async () => {
    await expect(DELETE(noConsumer())).rejects.toMatchObject({ status: 401 });
  });

  it('ok:true when nothing bound', async () => {
    const body = await (await DELETE(withConsumer(7))).json();
    expect(body).toEqual({ ok: true });
  });

  it('unbinds the consumer chat', async () => {
    bindChat(db, 99999, 'consumer', 7, null);
    // Confirm it's bound first
    let body = await (await GET(withConsumer(7))).json();
    expect(body.bound).toBe(true);
    // Delete it
    await DELETE(withConsumer(7));
    // Confirm unbound
    setBotToken(db, 'fake:token');
    setBotUsername(db, 'pulsebot');
    body = await (await GET(withConsumer(7))).json();
    expect(body.bound).toBe(false);
  });
});
