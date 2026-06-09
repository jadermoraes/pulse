import type { DB } from '../db';
import { listConnections } from '../connections';
import { getRole } from '../identity/roles';
import { updateConsumer, markActive } from '../identity/consumers';
import type { Capability, ConsumerUser, Role } from '../identity/types';
import { ensureJellyfinUser, deleteJellyfinUser } from './jellyfin';
import { ensureSeerrUserFromJellyfin, deleteSeerrUser } from './seerr';

export interface ProvisionCreds { username: string; password: string; plexToken?: string; }
export interface ProvisionResult {
  jellyfinUserId: string;
  seerrUserId: number;
  /** Best-effort B.2 step (Plex/WatchState) failed; the core provisioning is still good. */
  warning?: string;
}

// seerr (this jellyseerr fork) Permission bits — verified live against
// /app/dist/lib/permissions.js. NOTE: these differ from stock Overseerr.
//   ADMIN=2, MANAGE_USERS=8, MANAGE_REQUESTS=16, REQUEST=32,
//   AUTO_APPROVE=128, AUTO_APPROVE_MOVIE=256, AUTO_APPROVE_TV=512,
//   REQUEST_MOVIE=262144, REQUEST_TV=524288.
// A normal consumer must get REQUEST(32) — NEVER ADMIN(2). The old value of 2
// here silently granted every consumer full admin; that bug is fixed.
const PERM_REQUEST = 32;
const PERM_AUTO_APPROVE = 128;

/** Map a role's allow-list + auto_approve into a seerr permission bitmask. */
export function seerrPermissionsFor(role: Pick<Role, 'allowList' | 'autoApprove'>): number {
  let bits = 0;
  if (role.allowList.includes('request' as Capability)) bits |= PERM_REQUEST;
  if (role.autoApprove) bits |= PERM_AUTO_APPROVE;
  return bits;
}

export interface DeprovisionResult {
  warnings: string[];
}

/**
 * Best-effort de-provisioning: delete downstream Jellyfin and seerr accounts if they exist.
 * Each step is wrapped in a try/catch so a downstream failure never blocks the Pulse record
 * deletion. Returns { warnings } for the caller to surface to the admin.
 */
export async function deprovisionConsumer(
  db: DB, consumer: ConsumerUser
): Promise<DeprovisionResult> {
  const warnings: string[] = [];
  const conns = listConnections(db);

  if (consumer.jellyfinUserId) {
    const jellyfinConn = conns.find((c) => c.type === 'jellyfin' && c.enabled);
    if (jellyfinConn) {
      try {
        await deleteJellyfinUser(jellyfinConn, consumer.jellyfinUserId);
      } catch (e) {
        warnings.push(`Could not delete Jellyfin account: ${(e as Error).message}`);
      }
    }
  }

  if (consumer.seerrUserId != null) {
    const seerrConn = conns.find((c) => c.type === 'seerr' && c.enabled);
    if (seerrConn) {
      try {
        await deleteSeerrUser(seerrConn, consumer.seerrUserId);
      } catch (e) {
        warnings.push(`Could not delete seerr account: ${(e as Error).message}`);
      }
    }
  }

  return { warnings };
}

/**
 * Ordered, idempotent provisioning: Jellyfin → seerr.
 * On any failure after Jellyfin succeeds, best-effort rolls back the newly created Jellyfin user
 * and leaves the consumer in 'pending'. Surfaces the precise underlying error.
 *
 * B.2 extension points are marked below (Plex link/share, WatchState map) — wired in Task 20.
 */
export async function provisionConsumer(
  db: DB, consumer: ConsumerUser, creds: ProvisionCreds
): Promise<ProvisionResult> {
  // Test hook: a deterministic, hermetic provider boundary (no Jellyfin/seerr HTTP) for e2e.
  // The production code path below is untouched at runtime unless PULSE_PROVISION_FAKE=1.
  // Mirrors the agent loop's PULSE_AGENT_FAKE seam. A password of 'rejectme' lets a test
  // exercise the federated-login-rejected branch without a live server.
  if (process.env.PULSE_PROVISION_FAKE === '1') {
    const jellyfinUserId = 'jf-' + creds.username;
    let h = 0;
    for (let i = 0; i < jellyfinUserId.length; i++) h = (h * 31 + jellyfinUserId.charCodeAt(i)) | 0;
    const seerrUserId = (Math.abs(h) % 100000) + 1;
    updateConsumer(db, consumer.id, { jellyfinUserId, jellyfinUsername: creds.username, seerrUserId });
    // B.2 (fake): if a Plex token was supplied, store a synthetic plexAccountId + run the
    // (no-op) WatchState map so the e2e exercises the link path hermetically.
    if (creds.plexToken) {
      const { plexAccountFromToken } = await import('./plex-account');
      const acct = await plexAccountFromToken(creds.plexToken);
      updateConsumer(db, consumer.id, { plexAccountId: acct.id });
    }
    markActive(db, consumer.id);
    return { jellyfinUserId, seerrUserId };
  }

  const jellyfinConn = listConnections(db).find((c) => c.type === 'jellyfin' && c.enabled);
  if (!jellyfinConn) throw new Error('No enabled Jellyfin connection to provision against');
  const seerrConn = listConnections(db).find((c) => c.type === 'seerr' && c.enabled);
  if (!seerrConn) throw new Error('No enabled seerr connection to provision against');

  const role = getRole(db, consumer.roleId);
  if (!role) throw new Error('Consumer role not found');

  // Step 1 — Jellyfin (idempotent).
  const jellyfinUserId = await ensureJellyfinUser(jellyfinConn, creds.username, creds.password);
  // Track whether WE created it this run (idempotent ensure reuses existing — but for rollback
  // simplicity we only delete on a fresh provision where seerrUserId was still null).
  const createdFresh = consumer.seerrUserId == null && consumer.jellyfinUserId == null;
  updateConsumer(db, consumer.id, { jellyfinUserId, jellyfinUsername: creds.username });

  // Step 2 — seerr (idempotent). Roll back Jellyfin on failure.
  let seerrUserId: number;
  try {
    seerrUserId = await ensureSeerrUserFromJellyfin(
      seerrConn, jellyfinUserId, seerrPermissionsFor(role), role.seerrQuota
    );
  } catch (e) {
    if (createdFresh) {
      try { await deleteJellyfinUser(jellyfinConn, jellyfinUserId); } catch { /* best effort */ }
      updateConsumer(db, consumer.id, { jellyfinUserId: null });
    }
    throw e; // surface the precise error to the caller (the join endpoint)
  }
  updateConsumer(db, consumer.id, { seerrUserId });

  // The Jellyfin + seerr core is now solid → mark the consumer active BEFORE the optional B.2
  // steps so a Plex/WatchState failure can never roll back the working accounts.
  markActive(db, consumer.id);

  // --- B.2 (optional; best-effort; never rolls back the core) ------------------
  // Only runs when the onboarding flow supplied a Plex auth token. A failure here degrades:
  // we surface a warning and leave the consumer ACTIVE with their working Jellyfin+seerr
  // accounts, so the operator can retry the Plex/WatchState link later.
  let warning: string | undefined;
  if (creds.plexToken) {
    try {
      // A non-fatal sub-step failure (e.g. the Plex library share) returns a warning string
      // instead of throwing; a hard failure (account resolve / uniqueness) still throws.
      warning = await linkPlexAndWatchState(db, consumer, creds.plexToken, jellyfinUserId);
    } catch (e) {
      // Degrade: keep the consumer active, surface the Plex/WatchState failure to the caller.
      warning = `Plex/WatchState link failed: ${(e as Error).message}`;
      console.error('[provision] B.2 Plex/WatchState step failed (core unaffected)', e);
    }
  }

  return { jellyfinUserId, seerrUserId, warning };
}

/**
 * Detect a SQLite UNIQUE constraint violation (error code 19 / SQLITE_CONSTRAINT_UNIQUE).
 * better-sqlite3 surfaces these as a standard Error with `code: 'SQLITE_CONSTRAINT_UNIQUE'`.
 */
function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Error &&
    ('code' in e) &&
    ((e as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT_UNIQUE' ||
     (e as NodeJS.ErrnoException).code === 'SQLITE_CONSTRAINT')
  );
}

/**
 * B.2 link step, reused by the onboarding orchestrator and the post-onboarding "Link Plex" flow
 * (My Account). Resolves the Plex account from the token, stores `plexAccountId`, and — when a
 * WatchState connection exists — registers the cross-server identity map. Throws on failure; the
 * caller decides whether to degrade (orchestrator) or surface to the user (API route). NEVER
 * touches Jellyfin/seerr or the consumer status, so it can never roll back the core.
 *
 * Throws a typed `PlexAlreadyLinkedError` when the plexAccountId is already bound to a different
 * consumer, so callers can distinguish this case from generic failures.
 */
export class PlexAlreadyLinkedError extends Error {
  constructor() { super('This Plex account is already linked to another user'); this.name = 'PlexAlreadyLinkedError'; }
}

export async function linkPlexAndWatchState(
  db: DB, consumer: ConsumerUser, plexToken: string, jellyfinUserId: string | null
): Promise<string | undefined> {
  const { plexAccountFromToken } = await import('./plex-account');
  const acct = await plexAccountFromToken(plexToken);
  try {
    updateConsumer(db, consumer.id, { plexAccountId: acct.id });
  } catch (e) {
    if (isUniqueViolation(e)) throw new PlexAlreadyLinkedError();
    throw e;
  }
  // Best-effort Plex library share: if an enabled `plex` (owner) connection is configured,
  // invite the resolved account's email to ALL of the owner's library sections. Any failure
  // here is non-fatal — the account is already linked; we never roll back or throw out of it,
  // we just return a warning string for the caller to surface.
  const warning = await sharePlexLibrariesBestEffort(db, acct.email);

  const ws = listConnections(db).find((c) => c.type === 'watchstate' && c.enabled);
  if (ws) {
    const { mapWatchStateUser } = await import('./watchstate');
    await mapWatchStateUser(ws, {
      jellyfinUserId: jellyfinUserId ?? consumer.jellyfinUserId,
      plexAccountId: acct.id,
      displayName: consumer.displayName
    });
  }
  return warning;
}

// Plex owner endpoints used to resolve the machineIdentifier + library sections for the share.
const PLEX_IDENTITY = (baseUrl: string, token: string) =>
  `${baseUrl.replace(/\/$/, '')}/identity?X-Plex-Token=${encodeURIComponent(token)}`;
const PLEX_SECTIONS = (baseUrl: string, token: string) =>
  `${baseUrl.replace(/\/$/, '')}/library/sections?X-Plex-Token=${encodeURIComponent(token)}`;

/**
 * If an enabled `plex` connection exists, share ALL of the owner's library sections with
 * `invitedEmail` via the legacy v1 shared_servers endpoint. Pure best-effort: a missing
 * connection or any failure is swallowed (logged) — the Plex account is already linked, so a
 * share failure must never roll back the core or throw out of the link flow.
 */
async function sharePlexLibrariesBestEffort(db: DB, invitedEmail: string | undefined): Promise<string | undefined> {
  const plexConn = listConnections(db).find((c) => c.type === 'plex' && c.enabled);
  if (!plexConn) return undefined;    // no owner connection → skip sharing, account still links
  if (!invitedEmail) {
    console.error('[provision] Plex share skipped: no email on the resolved Plex account');
    return 'Plex library share skipped: no email on the linked Plex account';
  }
  try {
    const token = plexConn.secret ?? '';
    const idRes = await fetch(PLEX_IDENTITY(plexConn.baseUrl, token), { headers: { Accept: 'application/json' } });
    if (!idRes.ok) throw new Error(`identity → HTTP ${idRes.status}`);
    const idData = await idRes.json();
    const machineId: string | undefined =
      idData?.MediaContainer?.machineIdentifier ?? idData?.machineIdentifier;
    if (!machineId) throw new Error('no machineIdentifier from /identity');

    const secRes = await fetch(PLEX_SECTIONS(plexConn.baseUrl, token), { headers: { Accept: 'application/json' } });
    if (!secRes.ok) throw new Error(`sections → HTTP ${secRes.status}`);
    const secData = await secRes.json();
    const dirs: Array<{ key?: string | number }> = secData?.MediaContainer?.Directory ?? secData?.Directory ?? [];
    const sectionIds = dirs.map((d) => Number(d.key)).filter((n) => Number.isFinite(n));
    if (sectionIds.length === 0) throw new Error('no library sections to share');

    const { sharePlexLibraries } = await import('./plex');
    await sharePlexLibraries(token, machineId, sectionIds, invitedEmail);
    return undefined;
  } catch (e) {
    // Non-fatal: log and surface a warning. The consumer keeps their linked Plex account.
    console.error('[provision] Plex library share failed (best-effort, ignored)', e);
    return `Plex library share failed: ${(e as Error).message}`;
  }
}
