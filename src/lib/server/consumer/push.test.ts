import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { createRole } from '../identity/roles';
import { createConsumer } from '../identity/consumers';

const sendNotification = vi.fn();
vi.mock('web-push', () => ({
  default: {
    generateVAPIDKeys: () => ({ publicKey: 'PUB', privateKey: 'PRIV' }),
    setVapidDetails: vi.fn(),
    sendNotification: (...a: any[]) => sendNotification(...a)
  }
}));

import { getVapidKeys, subscribe, unsubscribe, sendPush } from './push';

let db: DB; let consumerId: number;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  const roleId = createRole(db, { name: 'M', allowList: [], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} });
  consumerId = createConsumer(db, { roleId, displayName: 'Ana', language: 'en' });
  sendNotification.mockReset().mockResolvedValue({});
});
afterEach(() => vi.restoreAllMocks());

const sub = { endpoint: 'https://push/abc', keys: { p256dh: 'P', auth: 'A' } };

describe('push', () => {
  it('generates VAPID keys once and persists them (public plain, private encrypted)', () => {
    const a = getVapidKeys(db); const b = getVapidKeys(db);
    expect(a.publicKey).toBe('PUB');
    expect(a).toEqual(b); // memoized/persisted, not regenerated
    const stored = db.prepare("select value from settings where key='vapid_private'").get() as any;
    expect(stored.value.startsWith('v1:')).toBe(true); // encrypted at rest
  });

  it('subscribe stores a row; duplicate endpoint is idempotent', () => {
    subscribe(db, consumerId, sub); subscribe(db, consumerId, sub);
    const rows = db.prepare('select * from push_subscriptions where consumer_id=?').all(consumerId);
    expect(rows.length).toBe(1);
  });

  it('unsubscribe removes the row', () => {
    subscribe(db, consumerId, sub);
    unsubscribe(db, consumerId, sub.endpoint);
    expect(db.prepare('select * from push_subscriptions where consumer_id=?').all(consumerId).length).toBe(0);
  });

  it('sendPush dispatches to each subscription with the payload', async () => {
    subscribe(db, consumerId, sub);
    await sendPush(db, consumerId, { title: 'Ready', body: 'Dune is available', url: '/app/requests' });
    expect(sendNotification).toHaveBeenCalledTimes(1);
    expect(sendNotification.mock.calls[0][1]).toContain('Dune is available');
  });

  it('sendPush prunes a gone (410) endpoint', async () => {
    subscribe(db, consumerId, sub);
    sendNotification.mockRejectedValueOnce(Object.assign(new Error('gone'), { statusCode: 410 }));
    await sendPush(db, consumerId, { title: 'x', body: 'y' });
    expect(db.prepare('select * from push_subscriptions where consumer_id=?').all(consumerId).length).toBe(0);
  });
});
