import type { DB } from '../db';
import { createMessage } from './messages';
import { notifyAdminsTracked } from '../notify';
import { recordEvent } from '../agent/events';
import { logAccess } from '../identity/access-log';

/**
 * Single entry point for a viewer→admin message (from the agent tool, the /app reply box, or
 * the "report a problem" button). Persists it, records a bell event so the admin sees it on the
 * dashboard, fires the tracked admin notify (Telegram), and logs the access event. Best-effort
 * on the side-effects; returns the new message id (0 if the body was empty).
 */
export async function submitConsumerMessage(db: DB, consumerId: number, body: string, who: string): Promise<number> {
  const msg = String(body ?? '').trim();
  if (!msg) return 0;
  const id = createMessage(db, consumerId, msg);
  try {
    recordEvent(db, {
      source: 'messages',
      type: 'consumer_message',
      severity: 'info',
      title: `Message from ${who}`,
      body: msg.slice(0, 140),
      dedupeKey: `consumer_message:${id}`
    });
  } catch { /* best-effort */ }
  await notifyAdminsTracked(db, { title: `Message from ${who}`, body: msg, url: '/messages' }, id).catch(() => {});
  logAccess(db, { consumerId, type: 'message_admin' });
  return id;
}
