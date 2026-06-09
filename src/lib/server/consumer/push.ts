import webpush from 'web-push';
import type { DB } from '../db';
import { getSetting, setSetting } from '../settings';
import { encryptSecret, decryptSecret } from '../crypto';
import type { PushSubscription } from './types';

export interface VapidKeys { publicKey: string; privateKey: string; }
export interface BrowserSub { endpoint: string; keys: { p256dh: string; auth: string }; }
export interface PushPayload { title: string; body: string; url?: string; }

const SUBJECT = 'mailto:admin@pulse.local';

/** Generate once, persist (public plain, private encrypted), then always read from settings. */
export function getVapidKeys(db: DB): VapidKeys {
  const pub = getSetting(db, 'vapid_public');
  const privEnc = getSetting(db, 'vapid_private');
  if (pub && privEnc) return { publicKey: pub, privateKey: decryptSecret(privEnc) };
  const keys = webpush.generateVAPIDKeys();
  setSetting(db, 'vapid_public', keys.publicKey);
  setSetting(db, 'vapid_private', encryptSecret(keys.privateKey));
  return keys;
}

export function subscribe(db: DB, consumerId: number, sub: BrowserSub): void {
  db.prepare(
    `insert into push_subscriptions (consumer_id, endpoint, p256dh, auth, created_at)
     values (?,?,?,?,?) on conflict(consumer_id, endpoint) do nothing`
  ).run(consumerId, sub.endpoint, sub.keys.p256dh, sub.keys.auth, Date.now());
}

export function unsubscribe(db: DB, consumerId: number, endpoint: string): void {
  db.prepare('delete from push_subscriptions where consumer_id=? and endpoint=?').run(consumerId, endpoint);
}

function rows(db: DB, consumerId: number): PushSubscription[] {
  return (db.prepare('select * from push_subscriptions where consumer_id=?').all(consumerId) as any[])
    .map((r) => ({ id: r.id, consumerId: r.consumer_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth }));
}

export async function sendPush(db: DB, consumerId: number, payload: PushPayload): Promise<void> {
  const keys = getVapidKeys(db);
  webpush.setVapidDetails(SUBJECT, keys.publicKey, keys.privateKey);
  const body = JSON.stringify(payload);
  for (const s of rows(db, consumerId)) {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } } as any, body
      );
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) unsubscribe(db, consumerId, s.endpoint); // endpoint gone
    }
  }
}
