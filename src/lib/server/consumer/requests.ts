import type { DB } from '../db';
import { listConnections, type Connection } from '../connections';
import { joinUrl, getJsonWithKey, sendJsonWithKey } from '../http';
import { resolveAudioProfile } from '../integrations/seerr';
import { resolveWidget } from '../../widgets';
import { SEERR_PATHS, type ConsumerRequest, type ConsumerRequestStatus } from './types';
import type { ConsumerUser } from '../identity/types';

function seerrConn(db: DB): Connection | null {
  return listConnections(db).find((c) => c.type === 'seerr' && c.enabled) ?? null;
}

function row(r: any): ConsumerRequest {
  return {
    id: r.id, consumerId: r.consumer_id, seerrRequestId: r.seerr_request_id,
    tmdbId: r.tmdb_id, mediaType: r.media_type, title: r.title,
    status: r.status as ConsumerRequestStatus, notified: !!r.notified, createdAt: r.created_at
  };
}

/** Map a seerr requests-widget status label → our ConsumerRequestStatus. */
export function mapSeerrLabel(label: string): ConsumerRequestStatus {
  switch (label) {
    case 'Available':
    case 'Partial': return 'available';
    case 'Declined':
    case 'Failed': return 'declined';
    case 'Pending':
    case 'Unreleased': return 'pending';
    default: return 'processing'; // Downloading / Searching / Queued / Requested
  }
}

export async function createConsumerRequest(
  db: DB, consumer: Pick<ConsumerUser, 'id' | 'seerrUserId'>,
  m: { tmdbId: number; mediaType: 'movie' | 'tv'; audio?: 'ptbr' | 'original' }
): Promise<ConsumerRequest> {
  const seerr = seerrConn(db);
  if (!seerr) throw new Error('No seerr connection configured');
  const body: Record<string, unknown> = { mediaType: m.mediaType, mediaId: m.tmdbId, userId: consumer.seerrUserId };
  if (m.mediaType === 'tv') body.seasons = 'all';
  // Audio preference → quality profile (PT-BR vs seerr's server default). Best-effort.
  const prof = await resolveAudioProfile(seerr, m.mediaType, m.audio);
  if (prof.profileId != null) {
    body.profileId = prof.profileId;
    if (prof.serverId != null) body.serverId = prof.serverId;
  }
  const created = await sendJsonWithKey(joinUrl(seerr.baseUrl, SEERR_PATHS.request), 'POST', seerr.secret, body);
  const seerrRequestId: number | null = typeof (created as any)?.id === 'number' ? (created as any).id : null;

  const detailPath = m.mediaType === 'tv' ? `/api/v1/tv/${m.tmdbId}` : `/api/v1/movie/${m.tmdbId}`;
  let title = `${m.mediaType} #${m.tmdbId}`;
  try {
    const d = await getJsonWithKey(joinUrl(seerr.baseUrl, detailPath), seerr.secret);
    title = (m.mediaType === 'tv' ? d.name : d.title) ?? title;
  } catch { /* keep fallback title */ }

  const info = db.prepare(
    `insert into consumer_requests (consumer_id, seerr_request_id, tmdb_id, media_type, title, status, notified, created_at)
     values (?,?,?,?,?, 'pending', 0, ?)`
  ).run(consumer.id, seerrRequestId, m.tmdbId, m.mediaType, title, Date.now());
  return row(db.prepare('select * from consumer_requests where id=?').get(Number(info.lastInsertRowid)));
}

/** Refresh tracked rows from the live seerr requests widget (by seerr_request_id). Returns rows flipped to a new status. */
export async function syncConsumerRequestStatus(db: DB): Promise<ConsumerRequest[]> {
  const seerr = seerrConn(db);
  if (!seerr) return [];
  const w = await resolveWidget(db, seerr.id, 'requests');
  if (!w.ok || !Array.isArray(w.data)) return [];
  const flipped: ConsumerRequest[] = [];
  for (const live of w.data as any[]) {
    const status = mapSeerrLabel(String(live.status));
    const existing = db.prepare('select * from consumer_requests where seerr_request_id=?').get(live.id) as any;
    if (existing && existing.status !== status) {
      db.prepare('update consumer_requests set status=? where seerr_request_id=?').run(status, live.id);
      flipped.push(row({ ...existing, status }));
    }
  }
  return flipped;
}

export async function listConsumerRequests(db: DB, consumerId: number): Promise<ConsumerRequest[]> {
  await syncConsumerRequestStatus(db); // refresh from live seerr before reading
  return (db.prepare('select * from consumer_requests where consumer_id=? order by created_at desc')
    .all(consumerId) as any[]).map(row);
}
