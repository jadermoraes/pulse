import type { DB } from '../db';
import { listConnections } from '../connections';
import { joinUrl, getJsonWithKey, sendJsonWithKey } from '../http';

export interface MyRequest { requestId: number; tmdbId: number | null; mediaType: string | null; title: string | null; status: string; }

// media.status: 5 Available, 4 Partial, 3 Processing, 2 Pending; request.status: 1 Pending, 3 Declined, 4 Failed.
function normalize(reqStatus: number, mediaStatus: number): string {
  if (reqStatus === 3) return 'declined';
  if (reqStatus === 4) return 'failed';
  if (mediaStatus === 5) return 'available';
  if (mediaStatus === 4) return 'partially available';
  if (mediaStatus === 3) return 'processing';
  if (reqStatus === 1) return 'pending';
  return 'approved';
}

function seerrConn(db: DB) { return listConnections(db).find((c) => c.type === 'seerr' && c.enabled) ?? null; }

/** This user's seerr requests (filtered client-side by requestedBy.id), normalized. */
export async function listMyRequests(db: DB, seerrUserId: number): Promise<MyRequest[]> {
  const conn = seerrConn(db);
  if (!conn) return [];
  const d = await getJsonWithKey(joinUrl(conn.baseUrl, '/api/v1/request', { take: 100, sort: 'added' }), conn.secret);
  return ((d.results ?? []) as any[])
    .filter((r) => r.requestedBy?.id === seerrUserId)
    .map((r) => ({
      requestId: r.id,
      tmdbId: r.media?.tmdbId ?? null,
      mediaType: r.media?.mediaType ?? null,
      title: r.media?.title ?? r.media?.name ?? null,
      status: normalize(r.status ?? 0, r.media?.status ?? 0)
    }));
}

/** Cancel (delete) a request that belongs to this user. Resolves requestId from tmdbId if needed. */
export async function cancelMyRequest(
  db: DB, seerrUserId: number, sel: { requestId?: number; tmdbId?: number; mediaType?: string }
): Promise<{ ok: boolean; error?: string }> {
  const conn = seerrConn(db);
  if (!conn) return { ok: false, error: 'No request service configured' };

  let requestId = sel.requestId;
  if (requestId == null && sel.tmdbId != null) {
    const mine = await listMyRequests(db, seerrUserId);
    requestId = mine.find((r) => r.tmdbId === Number(sel.tmdbId))?.requestId;
  }
  if (requestId == null) return { ok: false, error: 'No matching request found for you' };

  try {
    const req = await getJsonWithKey(joinUrl(conn.baseUrl, `/api/v1/request/${encodeURIComponent(String(requestId))}`), conn.secret);
    if (req?.requestedBy?.id !== seerrUserId) return { ok: false, error: 'That request is not yours to cancel' };
  } catch { return { ok: false, error: 'Could not verify the request' }; }

  try {
    await sendJsonWithKey(joinUrl(conn.baseUrl, `/api/v1/request/${encodeURIComponent(String(requestId))}`), 'DELETE', conn.secret);
    return { ok: true };
  } catch (e) { return { ok: false, error: (e as Error).message }; }
}
