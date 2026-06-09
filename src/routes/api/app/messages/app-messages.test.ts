import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import * as dbmod from '$lib/server/db';
import { createMessage } from '$lib/server/consumer/messages';
import * as submit from '$lib/server/consumer/submit-message';
import { GET, POST } from './+server';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  vi.spyOn(dbmod, 'getDb').mockReturnValue(db);
});
afterEach(() => vi.restoreAllMocks());

describe('GET /api/app/messages', () => {
  it("returns only the calling consumer's messages", async () => {
    createMessage(db, 7, 'mine');
    createMessage(db, 9, 'theirs');
    await expect(GET({ locals: {} } as any)).rejects.toMatchObject({ status: 401 });
    const res = await GET({ locals: { consumer: { id: 7 } } } as any);
    const data = await res.json();
    expect(data.messages).toHaveLength(1);
    expect(data.messages[0].body).toBe('mine');
  });
});

describe('POST /api/app/messages', () => {
  it('POST submits a follow-up message for the consumer', async () => {
    const spy = vi.spyOn(submit, 'submitConsumerMessage').mockResolvedValue(5);
    await expect(
      POST({ request: new Request('http://x', { method: 'POST', body: '{}' }), locals: {} } as any)
    ).rejects.toMatchObject({ status: 401 });
    const res = await POST({
      request: new Request('http://x', { method: 'POST', body: JSON.stringify({ body: 'still broken' }) }),
      locals: { consumer: { id: 7 } }
    } as any);
    expect((await res.json()).ok).toBe(true);
    expect(spy).toHaveBeenCalledWith(expect.anything(), 7, 'still broken', expect.any(String));
  });

  it('rejects empty body', async () => {
    await expect(
      POST({
        request: new Request('http://x', { method: 'POST', body: JSON.stringify({ body: '   ' }) }),
        locals: { consumer: { id: 7 } }
      } as any)
    ).rejects.toMatchObject({ status: 400 });
  });
});
