import type { DB } from '../db';
import { encryptSecret, decryptSecret } from '../crypto';

export type SpokeId = 'trakt' | 'stremio';

/** After this many consecutive failures a credential is disabled and the viewer is asked to relink. */
export const MAX_FAILS = 5;

export interface SpokeCredential {
  consumerId: number;
  spoke: SpokeId;
  secret: string;
  refresh: string | null;
  expiresAt: number | null;
  enabled: boolean;
  failCount: number;
  lastSyncAt: number | null;
  lastError: string | null;
}

function rowOf(r: any): SpokeCredential {
  return {
    consumerId: r.consumer_id,
    spoke: r.spoke,
    secret: decryptSecret(r.secret),
    refresh: r.refresh != null ? decryptSecret(r.refresh) : null,
    expiresAt: r.expires_at ?? null,
    enabled: !!r.enabled,
    failCount: r.fail_count,
    lastSyncAt: r.last_sync_at ?? null,
    lastError: r.last_error ?? null
  };
}

export function saveCredential(db: DB, c: {
  consumerId: number; spoke: SpokeId; secret: string;
  refresh?: string | null; expiresAt?: number | null;
}): void {
  db.prepare(
    `INSERT INTO spoke_credentials(consumer_id,spoke,secret,refresh,expires_at,enabled,fail_count,created_at)
     VALUES (?,?,?,?,?,1,0,?)
     ON CONFLICT(consumer_id,spoke) DO UPDATE SET
       secret=excluded.secret, refresh=excluded.refresh, expires_at=excluded.expires_at,
       enabled=1, fail_count=0, last_error=NULL`
  ).run(
    c.consumerId, c.spoke, encryptSecret(c.secret),
    c.refresh != null ? encryptSecret(c.refresh) : null,
    c.expiresAt ?? null, Date.now()
  );
}

export function getCredential(db: DB, consumerId: number, spoke: SpokeId): SpokeCredential | null {
  const r = db.prepare('SELECT * FROM spoke_credentials WHERE consumer_id=? AND spoke=?')
    .get(consumerId, spoke) as any;
  return r ? rowOf(r) : null;
}

export function listEnabled(db: DB, spoke: SpokeId): SpokeCredential[] {
  return (db.prepare('SELECT * FROM spoke_credentials WHERE spoke=? AND enabled=1')
    .all(spoke) as any[]).map(rowOf);
}

export function deleteCredential(db: DB, consumerId: number, spoke: SpokeId): void {
  db.prepare('DELETE FROM spoke_credentials WHERE consumer_id=? AND spoke=?').run(consumerId, spoke);
}

export function recordSuccess(db: DB, consumerId: number, spoke: SpokeId): void {
  db.prepare('UPDATE spoke_credentials SET fail_count=0, last_error=NULL, last_sync_at=? WHERE consumer_id=? AND spoke=?')
    .run(Date.now(), consumerId, spoke);
}

/**
 * Record a message on the credential WITHOUT counting it toward MAX_FAILS.
 *
 * `fail_count` never decays, so counting every thrown error would let a ten-minute upstream
 * outage (five poller ticks) permanently disable a working link — recoverable only by the
 * viewer noticing and relinking. Reserve `recordFailure` for failures that genuinely mean the
 * credential is dead (401/403); route transient failures and merely-notable outcomes here.
 */
export function recordNote(db: DB, consumerId: number, spoke: SpokeId, message: string): void {
  db.prepare('UPDATE spoke_credentials SET last_error=? WHERE consumer_id=? AND spoke=?')
    .run(message.slice(0, 500), consumerId, spoke);
}

/** Count a failure toward MAX_FAILS, disabling the credential once it is reached. */
export function recordFailure(db: DB, consumerId: number, spoke: SpokeId, message: string): void {
  db.prepare(
    `UPDATE spoke_credentials
        SET fail_count = fail_count + 1,
            last_error = ?,
            enabled = CASE WHEN fail_count + 1 >= ? THEN 0 ELSE enabled END
      WHERE consumer_id=? AND spoke=?`
  ).run(message.slice(0, 500), MAX_FAILS, consumerId, spoke);
}
