import type { Connection } from '../connections';

export interface WatchStateMapping {
  jellyfinUserId: string | null;
  plexAccountId: string | null;
  displayName: string;
}

/**
 * Documented no-op. The previously-attempted `POST /api/v1/users/map` does NOT exist on
 * WatchState 1.8.5 (404/405), the header was wrong (`X-Api-Key` vs `x-apikey`), and the box
 * has no `WS_API_KEY` configured. Real cross-backend identity mapping in WatchState 1.8 is a
 * BATCH operation (`/v1/api/identities/provision`), not a per-user call. Rather than ship a
 * call that is wrong on every axis, this is a clean no-op so onboarding is never affected —
 * cross-server play-state mapping stays a manual operator step for now.
 *
 * TODO (future): WatchState v1.8 cross-backend mapping is a batch
 * /v1/api/identities/provision operation, not per-user; revisit if auto-link is wanted.
 */
export async function mapWatchStateUser(_conn: Connection, _m: WatchStateMapping): Promise<void> {
  console.info(
    '[watchstate] WatchState auto-link not configured — cross-server play-state mapping remains manual'
  );
}
