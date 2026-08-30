import type { DB } from '../db';
import type { Connection } from '../connections';
import { createConnection, listConnections, updateConnection, deleteConnection } from '../connections';
import { MAX_FAILS } from './spoke-credentials';

/**
 * Stremio is a HOUSEHOLD spoke, not a per-viewer one: one account, on one TV, shared by the
 * consumers an admin nominates. Its credential therefore lives where the other household-wide
 * credentials live — the `connections` table — and not in `spoke_credentials`, which is keyed by
 * consumer and stays for Trakt.
 */
export const STREMIO_TYPE = 'stremio';

/**
 * `config.ts`'s import validator rejects a connection whose baseUrl is empty, so an exported
 * config would fail to re-import if this were ''. It is also simply true: this is the API the
 * integration talks to.
 */
const STREMIO_BASE_URL = 'https://api.strem.io';

export interface StremioHousehold {
  connection: Connection;
  email: string;
  participantIds: number[];
  lastSyncAt: number | null;
  lastError: string | null;
  failCount: number;
}

/** The one household row, enabled or not — the admin panel must be able to show a disabled link. */
export function getStremioConnection(db: DB): Connection | null {
  return listConnections(db).find((c) => c.type === STREMIO_TYPE) ?? null;
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * The participant list lives in a JSON blob with no foreign key, so an id whose consumer has
 * since been deleted is data we will see, not data we can prevent. Resolve against
 * `consumer_users` on every read and drop what no longer exists — silently, because a stale id
 * is an ordinary consequence of deleting a user, not an error the sync should stall on.
 */
export function participantIds(db: DB, conn: Connection): number[] {
  const raw = conn.options.participantIds;
  const ids = Array.isArray(raw) ? raw.filter((v): v is number => Number.isInteger(v)) : [];
  if (ids.length === 0) return [];
  const live = new Set(
    (db.prepare(`SELECT id FROM consumer_users WHERE id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as Array<{ id: number }>).map((r) => r.id)
  );
  return ids.filter((id) => live.has(id));
}

export function readHousehold(db: DB): StremioHousehold | null {
  const connection = getStremioConnection(db);
  if (!connection) return null;
  return {
    connection,
    email: str(connection.options.email) ?? '',
    participantIds: participantIds(db, connection),
    lastSyncAt: num(connection.options.lastSyncAt),
    lastError: str(connection.options.lastError),
    failCount: num(connection.options.failCount) ?? 0
  };
}

/**
 * Link, or relink after a key went stale. A relink keeps the participant list — the admin picked
 * those people and re-entering a password is not a request to forget them — and resets the health
 * counters, so a connection that MAX_FAILS had disabled comes back enabled.
 */
export function saveStremioConnection(db: DB, v: { email: string; authKey: string }): void {
  const existing = getStremioConnection(db);
  const options = {
    email: v.email,
    participantIds: existing ? participantIds(db, existing) : [],
    lastSyncAt: null,
    lastError: null,
    failCount: 0
  };
  if (existing) {
    updateConnection(db, existing.id, { secret: v.authKey, options, enabled: true });
  } else {
    createConnection(db, {
      type: STREMIO_TYPE, name: 'Stremio', baseUrl: STREMIO_BASE_URL,
      secret: v.authKey, options
    });
  }
}

export function setParticipants(db: DB, ids: number[]): void {
  const conn = getStremioConnection(db);
  if (!conn) return;
  // Filter on the way IN as well as on the way out: every read validates, so storing anything
  // else would silently vanish rather than fail loudly.
  const clean = [...new Set(ids.filter((v) => Number.isInteger(v)))];
  updateConnection(db, conn.id, { options: { ...conn.options, participantIds: clean } });
}

export function unlinkStremio(db: DB): void {
  const conn = getStremioConnection(db);
  if (conn) deleteConnection(db, conn.id);
}

/**
 * The three helpers below read the connection and write the whole options blob back, rather than
 * doing spoke-credentials' atomic `fail_count = fail_count + 1`. That is safe because better-sqlite3
 * is synchronous and Node is single-threaded: there is no await between the read and the write, so
 * no other handler can interleave. If any of this ever moves to an async driver, these must become
 * transactions or the poller and an admin request will clobber each other's blob.
 */

/** Mirrors spoke-credentials' recordSuccess: the credential worked this cycle. */
export function recordHouseholdSuccess(db: DB): void {
  const conn = getStremioConnection(db);
  if (!conn) return;
  updateConnection(db, conn.id, {
    options: { ...conn.options, failCount: 0, lastError: null, lastSyncAt: Date.now() }
  });
}

/**
 * Mirrors spoke-credentials' recordNote: leave a message WITHOUT counting toward MAX_FAILS.
 * `failCount` never decays, so counting every thrown error would let a ten-minute Stremio outage
 * (five poller ticks) permanently disable a working link. Reserve `recordHouseholdFailure` for
 * failures that mean the authKey itself is dead.
 */
export function recordHouseholdNote(db: DB, message: string): void {
  const conn = getStremioConnection(db);
  if (!conn) return;
  updateConnection(db, conn.id, {
    options: { ...conn.options, lastError: message.slice(0, 500) }
  });
}

/** Count a failure toward MAX_FAILS, disabling the connection once it is reached. */
export function recordHouseholdFailure(db: DB, message: string): void {
  const conn = getStremioConnection(db);
  if (!conn) return;
  const failCount = (num(conn.options.failCount) ?? 0) + 1;
  updateConnection(db, conn.id, {
    options: { ...conn.options, failCount, lastError: message.slice(0, 500) },
    enabled: failCount < MAX_FAILS ? conn.enabled : false
  });
}
