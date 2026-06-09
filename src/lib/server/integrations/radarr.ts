import type { Connection } from '../connections';
import type { Integration, WidgetResult, MediaDetail, DetailAction, DetailStatus } from './types';
import { registerIntegration } from './registry';
import { joinUrl, getJsonWithKey, sendJsonWithKey } from '../http';

function progressOf(rec: any): number {
  const size = Number(rec.size ?? 0);
  const left = Number(rec.sizeleft ?? 0);
  if (!size) return 0;
  return Math.round(((size - left) / size) * 100);
}

export const radarr: Integration = {
  type: 'radarr', label: 'Radarr', icon: 'radarr',
  configSchema: [
    { key: 'baseUrl', label: 'Server URL', type: 'url', required: true, placeholder: 'http://192.168.1.21:7878' },
    { key: 'secret', label: 'API Key', type: 'password', required: true }
  ],
  async testConnection(conn) {
    try {
      const s = await getJsonWithKey(joinUrl(conn.baseUrl, '/api/v3/system/status'), conn.secret);
      return { ok: true, message: `Connected · Radarr ${s.version ?? ''}`.trim() };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },
  widgets: {
    async queue(conn): Promise<WidgetResult> {
      try {
        const d = await getJsonWithKey(
          joinUrl(conn.baseUrl, '/api/v3/queue', { includeMovie: 'true', pageSize: 20 }),
          conn.secret
        );
        const data = (d.records ?? []).map((rec: any) => ({
          id: rec.id,
          title: rec.movie?.title ?? rec.title ?? 'Unknown',
          year: rec.movie?.year,
          status: rec.status ?? 'unknown',
          progress: progressOf(rec)
        }));
        return { ok: true, data };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    async wanted(conn): Promise<WidgetResult> {
      try {
        const d = await getJsonWithKey(
          joinUrl(conn.baseUrl, '/api/v3/wanted/missing', { pageSize: 30, sortKey: 'title', monitored: 'true' }),
          conn.secret
        );
        const records: any[] = d.records ?? [];
        const items = records.map((rec: any) => ({
          title: rec.title ?? 'Unknown',
          year: rec.year ?? null,
          status: rec.status ?? null,
          poster: (rec.images ?? []).find((i: any) => i.coverType === 'poster')?.remoteUrl ?? null,
          imdbId: rec.imdbId ?? null,
          runtime: rec.runtime ?? null,
          releaseDate: rec.inCinemas ?? rec.digitalRelease ?? rec.physicalRelease ?? rec.releaseDate ?? null
        }));
        return { ok: true, data: { count: d.totalRecords ?? 0, items } };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
  },
  actions: {
    deleteQueue: { id: 'deleteQueue', label: '🗑  Remove from queue', kind: 'movie',
      async run(conn, params) {
        const id = encodeURIComponent(String(params.id));
        await sendJsonWithKey(
          joinUrl(conn.baseUrl, `/api/v3/queue/${id}`, { removeFromClient: 'true', blocklist: 'true' }),
          'DELETE', conn.secret
        );
        return { ok: true, message: 'Removed from queue & blocklisted' };
      } },
    research: { id: 'research', label: '🔍  Re-search release', kind: 'movie',
      async run(conn, params) {
        await sendJsonWithKey(joinUrl(conn.baseUrl, '/api/v3/command'), 'POST', conn.secret,
          { name: 'MoviesSearch', movieIds: [Number(params.movieId)] });
        return { ok: true, message: 'Re-search triggered' };
      } },
    manageLink: { id: 'manageLink', label: '↗  Manage in Radarr', kind: 'movie',
      // Deep link only — no API call, no secret in the URL.
      async run(conn, params) {
        const movieId = encodeURIComponent(String(params.movieId));
        return { ok: true, url: `${conn.baseUrl.replace(/\/$/, '')}/movie/${movieId}` };
      } }
  },
  async detail(conn, params): Promise<MediaDetail> {
    // Look up by tmdbId (preferred) or radarr movie id.
    const query: Record<string, string | number> = {};
    if (params.tmdbId != null) query.tmdbId = Number(params.tmdbId);
    const list = await getJsonWithKey(joinUrl(conn.baseUrl, '/api/v3/movie', query), conn.secret);
    const arr: any[] = Array.isArray(list) ? list : [];
    const m = (params.movieId != null
      ? arr.find((x) => x.id === Number(params.movieId))
      : undefined) ?? arr[0] ?? {};

    const title: string = m.title ?? `movie #${params.tmdbId ?? params.movieId ?? ''}`;
    const releaseDate: string | undefined =
      m.digitalRelease || m.physicalRelease || m.inCinemas || undefined;
    const poster = (m.images ?? []).find((i: any) => i.coverType === 'poster')?.remoteUrl || undefined;
    const imdbUrl = m.imdbId ? `https://www.imdb.com/title/${m.imdbId}` : undefined;
    const rating: number | undefined = m.ratings?.tmdb?.value ?? m.ratings?.imdb?.value ?? undefined;
    const genres: string[] = Array.isArray(m.genres) ? m.genres : [];

    const released = m.status === 'released' || isPast(releaseDate);
    const status = resolveDetailStatus(!!m.hasFile, released);

    const fromQueue = params.fromQueue === true || params.fromQueue === 'true';
    const research: DetailAction = {
      id: 'research', label: 'Re-search release', icon: '🔍',
      kind: 'action', actionId: 'research', params: { movieId: m.id }, variant: 's'
    };
    const manage: DetailAction = {
      id: 'manageLink', label: 'Manage in Radarr', icon: '↗',
      kind: 'deeplink', actionId: 'manageLink', params: { movieId: m.id }, variant: 's'
    };
    const del: DetailAction = {
      id: 'deleteQueue', label: 'Remove from queue', icon: '🗑',
      kind: 'action', actionId: 'deleteQueue', params: { id: params.id }, variant: 'd'
    };

    let actions: DetailAction[];
    if (status.label === 'Unreleased') {
      actions = [manage];
    } else if (status.label === 'Available') {
      actions = [research, manage, ...(fromQueue ? [del] : [])];
    } else {
      // Missing / Queued
      actions = [research, manage, ...(fromQueue ? [del] : [])];
    }

    return {
      title, year: m.year || undefined, poster, overview: m.overview || undefined,
      runtimeMin: m.runtime && m.runtime > 0 ? m.runtime : undefined,
      rating, releaseDate, imdbUrl, genres, status, actions
    };
  }
};

function isPast(date: string | undefined): boolean {
  if (!date) return false;
  const t = Date.parse(date);
  return !Number.isNaN(t) && t <= Date.now();
}

function resolveDetailStatus(hasFile: boolean, released: boolean): DetailStatus {
  if (hasFile) return { label: 'Available', state: 'ok' };
  if (!released) return { label: 'Unreleased', state: 'idle' };
  return { label: 'Missing', state: 'proc' };
}
registerIntegration(radarr);
