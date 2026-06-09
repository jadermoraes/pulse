import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import * as dbmod from '$lib/server/db';
import * as notify from '$lib/server/notify';
import { createMessage, getMessage } from '$lib/server/consumer/messages';
import { GET } from './+server';
import { POST } from './[id]/reply/+server';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:');
  migrate(db);
  vi.spyOn(dbmod, 'getDb').mockReturnValue(db);
});
afterEach(() => vi.restoreAllMocks());

describe('messages admin API', () => {
  it('GET requires admin and returns messages + unread', async () => {
    createMessage(db, 1, 'hi');
    await expect(
      GET({ url: new URL('http://x/api/messages'), locals: {} } as any)
    ).rejects.toMatchObject({ status: 401 });
    const res = await GET({
      url: new URL('http://x/api/messages'),
      locals: { user: { id: 1 } }
    } as any);
    const data = await res.json();
    expect(data.messages).toHaveLength(1);
  });

  it('GET marks listed messages read', async () => {
    createMessage(db, 1, 'hi');
    await GET({
      url: new URL('http://x/api/messages'),
      locals: { user: { id: 1 } }
    } as any);
    const res2 = await GET({
      url: new URL('http://x/api/messages?unreadOnly=1'),
      locals: { user: { id: 1 } }
    } as any);
    expect((await res2.json()).messages).toHaveLength(0);
  });

  it('POST reply stores the reply and notifies the consumer', async () => {
    const spy = vi.spyOn(notify, 'notifyConsumer').mockResolvedValue(undefined);
    const id = createMessage(db, 7, 'broken');
    const res = await POST({
      params: { id: String(id) },
      request: new Request('http://x', { method: 'POST', body: JSON.stringify({ body: 'fixed' }) }),
      locals: { user: { id: 1 } }
    } as any);
    await res.json();
    expect(getMessage(db, id)!.replyBody).toBe('fixed');
    expect(spy).toHaveBeenCalledWith(
      db,
      7,
      expect.objectContaining({ body: 'fixed', url: '/app/messages' })
    );
  });

  it('POST reply requires admin', async () => {
    const id = createMessage(db, 7, 'broken');
    await expect(
      POST({
        params: { id: String(id) },
        request: new Request('http://x', { method: 'POST', body: JSON.stringify({ body: 'x' }) }),
        locals: {}
      } as any)
    ).rejects.toMatchObject({ status: 401 });
  });

  it('POST reply rejects empty body and unknown id', async () => {
    await expect(
      POST({
        params: { id: '1' },
        request: new Request('http://x', { method: 'POST', body: JSON.stringify({ body: '   ' }) }),
        locals: { user: { id: 1 } }
      } as any)
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      POST({
        params: { id: '999' },
        request: new Request('http://x', { method: 'POST', body: JSON.stringify({ body: 'x' }) }),
        locals: { user: { id: 1 } }
      } as any)
    ).rejects.toMatchObject({ status: 404 });
  });
});
