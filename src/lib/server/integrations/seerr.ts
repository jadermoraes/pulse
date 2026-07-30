import type { Connection } from '../connections';
import type { Integration, WidgetResult, MediaDetail, DetailAction, DetailStatus } from './types';
import { registerIntegration } from './registry';
import { joinUrl, getJsonWithKey, sendJsonWithKey } from '../http';
import { publicBase } from '../public-url';

// request.status (MediaRequestStatus): 1=Pending, 2=Approved, 3=Declined, 4=Failed, 5=Completed
// media.status (MediaStatus):          1=Unknown, 2=Pending, 3=Processing, 4=Partially Available, 5=Available

/**
 * Resolve the *arr quality profile for a request's audio preference.
 *
 * 'ptbr' → the profile whose name matches PT-BR on the default radarr (movie) / sonarr (tv)
 * server, so the request grabs the Brazilian-Portuguese profile instead of seerr's server
 * default. Anything else → {} (let seerr use its default). Best-effort: any failure returns {},
 * so a request never breaks just because profile discovery hiccupped.
 */
export async function resolveAudioProfile(
  conn: Connection, mediaType: 'movie' | 'tv', audio: string | undefined
): Promise<{ profileId?: number; serverId?: number }> {
  if (audio !== 'ptbr') return {};
  const svc = mediaType === 'tv' ? 'sonarr' : 'radarr';
  try {
    const servers = await getJsonWithKey(joinUrl(conn.baseUrl, `/api/v1/service/${svc}`), conn.secret);
    const list = Array.isArray(servers) ? servers : [];
    const server = list.find((s: { isDefault?: boolean }) => s.isDefault) ?? list[0];
    if (!server) return {};
    const detail = await getJsonWithKey(joinUrl(conn.baseUrl, `/api/v1/service/${svc}/${server.id}`), conn.secret);
    const profiles: Array<{ id: number; name: string }> = Array.isArray(detail?.profiles) ? detail.profiles : [];
    const ptbr = profiles.find((p) => /pt[\s._-]?br/i.test(String(p.name)));
    return ptbr ? { profileId: Number(ptbr.id), serverId: Number(server.id) } : {};
  } catch {
    return {};
  }
}

// TMDB status / release-date → has the title been released yet?
function isReleased(tmdbStatus: string | undefined, releaseDate: string | undefined): boolean {
  if (releaseDate) {
    const t = Date.parse(releaseDate);
    if (!Number.isNaN(t)) return t <= Date.now();
  }
  // No usable date — trust the TMDB status string.
  return tmdbStatus === 'Released';
}

/**
 * Single source of truth for seerr status taxonomy.
 * Used by both the requests widget card and the detail drawer.
 *
 * Priority order:
 *   1. request.status 3/4 → Declined / Failed (bad)
 *   2. media.status 5 → Available (ok)
 *   3. media.status 4 → Partial (ok)
 *   4. downloadCount > 0 → Downloading (proc) — the ONLY thing that reads as actively downloading
 *   5. request.status 1 → Pending (proc)
 *   6. !released (future date or tmdbStatus ≠ Released) → Unreleased (idle)
 *   7. media.status 3, released, no active download → Searching (proc) — monitored but nothing downloading
 *   8. approved + released + mediaStatus 2 → Queued (proc)
 *   9. fallback → Requested (proc)
 */
export function computeSeerrStatus(opts: {
  requestStatus: number;
  mediaStatus: number;
  releaseDate?: string;
  tmdbStatus?: string;
  downloadCount?: number;
}): DetailStatus {
  const { requestStatus, mediaStatus, releaseDate, tmdbStatus, downloadCount = 0 } = opts;
  if (requestStatus === 3) return { label: 'Declined', state: 'bad' };
  if (requestStatus === 4) return { label: 'Failed', state: 'bad' };
  if (mediaStatus === 5) return { label: 'Available', state: 'ok' };
  if (mediaStatus === 4) return { label: 'Partial', state: 'ok' };
  if (downloadCount > 0) return { label: 'Downloading', state: 'proc' };
  if (requestStatus === 1) return { label: 'Pending', state: 'proc' };
  // Below here: request is approved (2) and media is pending (2/1) or processing (3)
  const released = isReleased(tmdbStatus, releaseDate);
  if (!released) return { label: 'Unreleased', state: 'idle' };
  // Released, no active download — check media state
  if (mediaStatus === 3) return { label: 'Searching', state: 'proc' };
  // approved + released + mediaStatus 2 or 1 → queued for download
  if (mediaStatus === 2) return { label: 'Queued', state: 'proc' };
  return { label: 'Requested', state: 'proc' };
}

const TMDB_IMG = 'https://image.tmdb.org/t/p/w342';

async function resolveMedia(
  conn: Connection,
  tmdbId: number,
  mediaType: string
): Promise<{ title: string; poster: string | null; releaseDate?: string; tmdbStatus?: string }> {
  const path = mediaType === 'tv' ? `/api/v1/tv/${tmdbId}` : `/api/v1/movie/${tmdbId}`;
  try {
    const m = await getJsonWithKey(joinUrl(conn.baseUrl, path), conn.secret);
    const title: string = (mediaType === 'tv' ? m.name : m.title) ?? `${mediaType} #${tmdbId}`;
    const poster: string | null = m.posterPath ? TMDB_IMG + m.posterPath : null;
    const releaseDate: string | undefined =
      (mediaType === 'tv' ? m.firstAirDate : m.releaseDate) || undefined;
    const tmdbStatus: string | undefined =
      typeof m.status === 'string' ? m.status : undefined;
    return { title, poster, releaseDate, tmdbStatus };
  } catch {
    return { title: `${mediaType} #${tmdbId}`, poster: null };
  }
}

export const seerr: Integration = {
  type: 'seerr', label: 'Seerr', icon: 'overseerr',
  configSchema: [
    { key: 'baseUrl', label: 'Server URL', type: 'url', required: true, placeholder: 'http://192.168.1.21:5055' },
    { key: 'secret', label: 'API Key', type: 'password', required: true }
  ],
  async testConnection(conn) {
    try {
      const info = await getJsonWithKey(joinUrl(conn.baseUrl, '/api/v1/status'), conn.secret);
      return { ok: true, message: `Connected · seerr ${info.version ?? ''}`.trim() };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },
  widgets: {
    async requests(conn): Promise<WidgetResult> {
      try {
        const d = await getJsonWithKey(
          joinUrl(conn.baseUrl, '/api/v1/request', { take: 12, sort: 'added' }),
          conn.secret
        );
        const results: any[] = d.results ?? [];

        // Resolve title + poster + release info for all requests in parallel; failures fall back gracefully
        const resolved = await Promise.all(
          results.map(async (r: any) => {
            const tmdbId: number = r.media?.tmdbId ?? r.id;
            const mediaType: string = r.media?.mediaType ?? r.type ?? 'movie';
            const requestStatus: number = r.status ?? 0;
            const mediaStatus: number = r.media?.status ?? 0;
            const downloadCount: number = Array.isArray(r.media?.downloadStatus) ? r.media.downloadStatus.length : 0;

            const { title, poster, releaseDate, tmdbStatus } = await resolveMedia(conn, tmdbId, mediaType);
            const { label: statusLabel, state } = computeSeerrStatus({
              requestStatus, mediaStatus, releaseDate, tmdbStatus, downloadCount
            });

            return {
              id: r.id,
              tmdbId,
              mediaType,
              title,
              poster,
              status: statusLabel,
              state,
              requestedBy: r.requestedBy?.displayName ?? r.requestedBy?.plexUsername ?? r.requestedBy?.username ?? '—'
            };
          })
        );

        return { ok: true, data: resolved };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    async requestCounts(conn): Promise<WidgetResult> {
      try {
        const c = await getJsonWithKey(joinUrl(conn.baseUrl, '/api/v1/request/count'), conn.secret);
        return { ok: true, data: {
          total: c.total ?? 0, pending: c.pending ?? 0,
          approved: c.approved ?? 0, declined: c.declined ?? 0,
          processing: c.processing ?? 0, available: c.available ?? 0
        } };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
  },
  actions: {
    request: { id: 'request', label: '＋  Request', kind: 'request',
      async run(conn, params) {
        const mediaType = params.mediaType === 'tv' ? 'tv' : 'movie';
        const body: Record<string, unknown> = {
          mediaType,
          mediaId: Number(params.tmdbId),
          ...(mediaType === 'tv' ? { seasons: 'all' } : {}),
          ...(params.userId != null ? { userId: Number(params.userId) } : {})
        };
        // Audio/profile targeting: an explicit profileId wins; otherwise audio:'ptbr' resolves
        // to the PT-BR quality profile. Neither present → seerr's server default.
        const prof = params.profileId != null
          ? { profileId: Number(params.profileId), serverId: params.serverId != null ? Number(params.serverId) : undefined }
          : await resolveAudioProfile(conn, mediaType, params.audio != null ? String(params.audio) : undefined);
        if (prof.profileId != null) {
          body.profileId = prof.profileId;
          if (prof.serverId != null) body.serverId = prof.serverId;
        }
        const res = await sendJsonWithKey(joinUrl(conn.baseUrl, '/api/v1/request'), 'POST', conn.secret, body);
        return { ok: true, message: 'Requested', request: res };
      } },
    approve: { id: 'approve', label: '✓  Approve', kind: 'request',
      async run(conn, params) {
        const id = encodeURIComponent(String(params.id));
        await sendJsonWithKey(joinUrl(conn.baseUrl, `/api/v1/request/${id}/approve`), 'POST', conn.secret);
        return { ok: true, message: 'Request approved' };
      } },
    decline: { id: 'decline', label: '✕  Decline', kind: 'request',
      async run(conn, params) {
        const id = encodeURIComponent(String(params.id));
        await sendJsonWithKey(joinUrl(conn.baseUrl, `/api/v1/request/${id}/decline`), 'POST', conn.secret);
        return { ok: true, message: 'Request declined' };
      } },
    research: { id: 'research', label: '🔍  Re-search', kind: 'request',
      // Implementer: verify `/retry` on your seerr build; it re-processes the request.
      async run(conn, params) {
        try {
          const id = encodeURIComponent(String(params.id));
          await sendJsonWithKey(joinUrl(conn.baseUrl, `/api/v1/request/${id}/retry`), 'POST', conn.secret);
          return { ok: true, message: 'Re-search triggered' };
        } catch (e) {
          return { ok: false, message: (e as Error).message };
        }
      } },
    viewInSeerr: { id: 'viewInSeerr', label: '↗  View in seerr', kind: 'request',
      // Deep link to the media page in seerr — no API call, no secret in the URL.
      async run(conn, params) {
        const mediaType = params.mediaType === 'tv' ? 'tv' : 'movie';
        const tmdbId = encodeURIComponent(String(params.tmdbId));
        const base = publicBase('seerr', conn.baseUrl);
        return { ok: true, url: `${base.replace(/\/$/, '')}/${mediaType}/${tmdbId}` };
      } }
  },
  async detail(conn, params): Promise<MediaDetail> {
    const mediaType = params.mediaType === 'tv' ? 'tv' : 'movie';
    const tmdbId = Number(params.tmdbId);
    const requestId = params.id != null ? String(params.id) : null;

    // Re-fetch the request for fresh request.status + mediaInfo.status (params may be stale).
    let requestStatus = Number(params.requestStatus ?? 0);
    let mediaStatus = Number(params.mediaStatus ?? 0);
    let downloadCount = 0;
    if (requestId) {
      try {
        const req = await getJsonWithKey(
          joinUrl(conn.baseUrl, `/api/v1/request/${encodeURIComponent(requestId)}`),
          conn.secret
        );
        if (typeof req?.status === 'number') requestStatus = req.status;
        if (typeof req?.media?.status === 'number') mediaStatus = req.media.status;
        if (Array.isArray(req?.media?.downloadStatus)) downloadCount = req.media.downloadStatus.length;
      } catch {
        // fall back to whatever was passed in params
      }
    }

    const path = mediaType === 'tv' ? `/api/v1/tv/${tmdbId}` : `/api/v1/movie/${tmdbId}`;
    const m = await getJsonWithKey(joinUrl(conn.baseUrl, path), conn.secret);

    const title: string = (mediaType === 'tv' ? m.name : m.title) ?? `${mediaType} #${tmdbId}`;
    const releaseDate: string | undefined =
      (mediaType === 'tv' ? m.firstAirDate : m.releaseDate) || undefined;
    const year = releaseDate ? Number(releaseDate.slice(0, 4)) || undefined : undefined;
    const runtimeMin: number | undefined =
      mediaType === 'tv'
        ? (Array.isArray(m.episodeRunTime) ? m.episodeRunTime[0] : undefined)
        : (typeof m.runtime === 'number' && m.runtime > 0 ? m.runtime : undefined);
    const poster = m.posterPath ? TMDB_IMG + m.posterPath : undefined;
    const imdbUrl = m.imdbId ? `https://www.imdb.com/title/${m.imdbId}` : undefined;
    const genres: string[] = Array.isArray(m.genres)
      ? m.genres.map((g: any) => g?.name).filter(Boolean)
      : [];

    const status = computeSeerrStatus({ requestStatus, mediaStatus, releaseDate, tmdbStatus: m.status, downloadCount });

    const linkParams = { tmdbId, mediaType };
    const viewInSeerr: DetailAction = {
      id: 'viewInSeerr', label: 'View in seerr', icon: '↗',
      kind: 'deeplink', actionId: 'viewInSeerr', params: linkParams, variant: 's'
    };
    const research: DetailAction = {
      id: 'research', label: 'Re-search', icon: '🔍',
      kind: 'action', actionId: 'research', params: requestId ? { id: requestId } : {}, variant: 's'
    };
    const approve: DetailAction = {
      id: 'approve', label: 'Approve', icon: '✓',
      kind: 'action', actionId: 'approve', params: requestId ? { id: requestId } : {}, variant: 'p'
    };
    const decline: DetailAction = {
      id: 'decline', label: 'Decline', icon: '✕',
      kind: 'action', actionId: 'decline', params: requestId ? { id: requestId } : {}, variant: 'd'
    };

    let actions: DetailAction[];
    switch (status.label) {
      case 'Pending':
        actions = [approve, decline, research];
        break;
      case 'Available':
      case 'Partial':
        actions = [research, viewInSeerr];
        break;
      case 'Downloading':
      case 'Searching':
      case 'Queued':
      case 'Requested':
        actions = [research, decline, viewInSeerr];
        break;
      case 'Unreleased':
        actions = [viewInSeerr];
        break;
      default: // Declined / Failed
        actions = [viewInSeerr];
    }

    return {
      title, year, poster, overview: m.overview || undefined,
      runtimeMin, rating: typeof m.voteAverage === 'number' ? m.voteAverage : undefined,
      releaseDate, imdbUrl, genres, status, actions
    };
  }
};

registerIntegration(seerr);
