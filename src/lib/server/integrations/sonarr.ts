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

function episodeTitle(rec: any): string {
  const series = rec.series?.title ?? rec.title ?? 'Unknown';
  const ep = rec.episode;
  if (ep && ep.seasonNumber != null && ep.episodeNumber != null) {
    return `${series} · S${ep.seasonNumber}·E${ep.episodeNumber}`;
  }
  return series;
}

export const sonarr: Integration = {
  type: 'sonarr', label: 'Sonarr', icon: 'sonarr',
  configSchema: [
    { key: 'baseUrl', label: 'Server URL', type: 'url', required: true, placeholder: 'http://192.168.1.21:8989' },
    { key: 'secret', label: 'API Key', type: 'password', required: true }
  ],
  async testConnection(conn) {
    try {
      const s = await getJsonWithKey(joinUrl(conn.baseUrl, '/api/v3/system/status'), conn.secret);
      return { ok: true, message: `Connected · Sonarr ${s.version ?? ''}`.trim() };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },
  widgets: {
    async queue(conn): Promise<WidgetResult> {
      try {
        const d = await getJsonWithKey(
          joinUrl(conn.baseUrl, '/api/v3/queue', { includeSeries: 'true', includeEpisode: 'true', pageSize: 20 }),
          conn.secret
        );
        const data = (d.records ?? []).map((rec: any) => ({
          id: rec.id,
          title: episodeTitle(rec),
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
          joinUrl(conn.baseUrl, '/api/v3/wanted/missing', { pageSize: 30 }),
          conn.secret
        );
        const records: any[] = d.records ?? [];
        const items = records.map((rec: any) => {
          const series = rec.series ?? {};
          const sn = rec.seasonNumber ?? 0;
          const en = rec.episodeNumber ?? 0;
          const episodeTitleStr = rec.title ? ` — ${rec.title}` : '';
          return {
            title: `${series.title ?? 'Unknown'} — S${String(sn).padStart(2, '0')}·E${String(en).padStart(2, '0')}${episodeTitleStr}`,
            year: series.year ?? null,
            status: 'wanted',
            poster: (series.images ?? []).find((i: any) => i.coverType === 'poster')?.remoteUrl ?? null,
            releaseDate: rec.airDateUtc ?? null
          };
        });
        return { ok: true, data: { count: d.totalRecords ?? 0, items } };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
  },
  actions: {
    deleteQueue: { id: 'deleteQueue', label: '🗑  Remove from queue', kind: 'series',
      async run(conn, params) {
        const id = encodeURIComponent(String(params.id));
        await sendJsonWithKey(
          joinUrl(conn.baseUrl, `/api/v3/queue/${id}`, { removeFromClient: 'true', blocklist: 'true' }),
          'DELETE', conn.secret
        );
        return { ok: true, message: 'Removed from queue & blocklisted' };
      } },
    research: { id: 'research', label: '🔍  Re-search release', kind: 'series',
      async run(conn, params) {
        await sendJsonWithKey(joinUrl(conn.baseUrl, '/api/v3/command'), 'POST', conn.secret,
          { name: 'SeriesSearch', seriesId: Number(params.seriesId) });
        return { ok: true, message: 'Re-search triggered' };
      } },
    manageLink: { id: 'manageLink', label: '↗  Manage in Sonarr', kind: 'series',
      // Sonarr series detail route uses the title slug. Implementer: queue rows may not carry the slug;
      // the LIBRARY/wanted path (where the series object is present) supplies it.
      async run(conn, params) {
        const titleSlug = encodeURIComponent(String(params.titleSlug));
        return { ok: true, url: `${conn.baseUrl.replace(/\/$/, '')}/series/${titleSlug}` };
      } }
  },
  async detail(conn, params): Promise<MediaDetail> {
    // Look up by series id (preferred) or tvdbId.
    let m: any = {};
    if (params.seriesId != null) {
      m = await getJsonWithKey(
        joinUrl(conn.baseUrl, `/api/v3/series/${encodeURIComponent(String(params.seriesId))}`),
        conn.secret
      );
    } else if (params.tvdbId != null) {
      const list = await getJsonWithKey(
        joinUrl(conn.baseUrl, '/api/v3/series', { tvdbId: Number(params.tvdbId) }),
        conn.secret
      );
      m = (Array.isArray(list) ? list[0] : list) ?? {};
    }

    const title: string = m.title ?? `series #${params.seriesId ?? params.tvdbId ?? ''}`;
    const poster = (m.images ?? []).find((i: any) => i.coverType === 'poster')?.remoteUrl || undefined;
    const imdbUrl = m.imdbId ? `https://www.imdb.com/title/${m.imdbId}` : undefined;
    const rating: number | undefined =
      typeof m.ratings?.value === 'number' ? m.ratings.value : undefined;
    const genres: string[] = Array.isArray(m.genres) ? m.genres : [];
    const fileCount = Number(m.statistics?.episodeFileCount ?? 0);
    const epCount = Number(m.statistics?.episodeCount ?? 0);

    const released = m.status !== 'announced' && isPast(m.firstAired);
    const status = resolveDetailStatus(fileCount, epCount, released);

    const fromQueue = params.fromQueue === true || params.fromQueue === 'true';
    const research: DetailAction = {
      id: 'research', label: 'Re-search release', icon: '🔍',
      kind: 'action', actionId: 'research', params: { seriesId: m.id }, variant: 's'
    };
    const manage: DetailAction = {
      id: 'manageLink', label: 'Manage in Sonarr', icon: '↗',
      kind: 'deeplink', actionId: 'manageLink', params: { titleSlug: m.titleSlug }, variant: 's'
    };
    const del: DetailAction = {
      id: 'deleteQueue', label: 'Remove from queue', icon: '🗑',
      kind: 'action', actionId: 'deleteQueue', params: { id: params.id }, variant: 'd'
    };

    const actions: DetailAction[] =
      status.label === 'Unreleased'
        ? [manage]
        : [research, manage, ...(fromQueue ? [del] : [])];

    return {
      title, year: m.year || undefined, poster, overview: m.overview || undefined,
      runtimeMin: m.runtime && m.runtime > 0 ? m.runtime : undefined,
      rating, releaseDate: m.firstAired || undefined, imdbUrl, genres, status, actions
    };
  }
};

function isPast(date: string | undefined): boolean {
  if (!date) return false;
  const t = Date.parse(date);
  return !Number.isNaN(t) && t <= Date.now();
}

function resolveDetailStatus(fileCount: number, epCount: number, released: boolean): DetailStatus {
  if (fileCount > 0 && epCount > 0 && fileCount >= epCount) return { label: 'Available', state: 'ok' };
  if (fileCount > 0) return { label: 'Partial', state: 'ok' };
  if (!released) return { label: 'Unreleased', state: 'idle' };
  return { label: 'Missing', state: 'proc' };
}
registerIntegration(sonarr);
