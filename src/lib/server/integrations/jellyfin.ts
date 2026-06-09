import type { Connection } from '../connections';
import type { Integration, WidgetResult, MediaDetail, ImageRequest } from './types';
import { registerIntegration } from './registry';
import { joinUrl } from '../http';
import { publicBase } from '../public-url';

function api(conn: Connection, path: string, query: Record<string, string> = {}) {
  const u = new URL(conn.baseUrl.replace(/\/$/, '') + path);
  u.searchParams.set('api_key', conn.secret ?? '');
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}
async function getJson(url: string): Promise<any> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

export const jellyfin: Integration = {
  type: 'jellyfin', label: 'Jellyfin', icon: 'jellyfin',
  configSchema: [
    { key: 'baseUrl', label: 'Server URL', type: 'url', required: true, placeholder: 'http://192.168.1.21:8096' },
    { key: 'secret', label: 'API Key', type: 'password', required: true }
  ],
  async testConnection(conn) {
    try { const info = await getJson(api(conn, '/System/Info'));
      return { ok: true, message: `Connected · Jellyfin ${info.Version ?? ''}`.trim() }; }
    catch (e) { return { ok: false, message: (e as Error).message }; }
  },
  widgets: {
    async recentlyAdded(conn): Promise<WidgetResult> {
      try {
        const d = await getJson(api(conn, '/Items', {
          Recursive: 'true', IncludeItemTypes: 'Movie,Series', SortBy: 'DateCreated',
          SortOrder: 'Descending', Limit: '20', Fields: 'ProductionYear,ImageTags'
        }));
        return { ok: true, data: (d.Items ?? []).map((i: any) => ({
          id: i.Id, title: i.Name, year: i.ProductionYear, kind: i.Type,
          image: i.ImageTags?.Primary
            ? `/Items/${i.Id}/Images/Primary?fillWidth=300&fillHeight=450&quality=90&tag=${i.ImageTags.Primary}`
            : null
        })) };
      } catch (e) { return { ok: false, error: (e as Error).message }; }
    },
    async nowPlaying(conn): Promise<WidgetResult> {
      try {
        const sessions = await getJson(api(conn, '/Sessions'));
        const active = (sessions as any[]).filter((s) => s.NowPlayingItem).map((s) => ({
          user: s.UserName, title: s.NowPlayingItem.Name, client: s.Client ?? '',
          progress: s.PlayState?.PositionTicks && s.NowPlayingItem.RunTimeTicks
            ? Math.round((s.PlayState.PositionTicks / s.NowPlayingItem.RunTimeTicks) * 100) : 0 }));
        return { ok: true, data: active };
      } catch (e) { return { ok: false, error: (e as Error).message }; }
    }
  },
  actions: {
    playInJellyfin: { id: 'playInJellyfin', label: '▶  Play in Jellyfin', kind: 'movie',
      async run(conn, params) {
        const base = publicBase('jellyfin', conn.baseUrl);
        return { ok: true, url: `${base.replace(/\/$/, '')}/web/#/details?id=${params.id}` };
      } }
  },
  imageRequest(conn: Connection, path: string): ImageRequest {
    return {
      url: joinUrl(conn.baseUrl, path),
      headers: conn.secret ? { 'X-Emby-Token': conn.secret } : {}
    };
  },
  async detail(conn, params): Promise<MediaDetail> {
    const id = String(params.id);
    const d = await getJson(api(conn, '/Items', {
      Ids: id,
      Fields: 'Overview,Genres,RunTimeTicks,CommunityRating,ProductionYear'
    }));
    const item = (d.Items ?? [])[0] ?? {};

    const title: string = item.Name ?? `item #${id}`;
    const poster = item.ImageTags?.Primary
      ? `/api/image/${conn.id}?path=${encodeURIComponent(
          `/Items/${id}/Images/Primary?fillWidth=400&fillHeight=600&quality=90&tag=${item.ImageTags.Primary}`
        )}`
      : undefined;
    const runtimeMin = item.RunTimeTicks
      ? Math.round(item.RunTimeTicks / 600_000_000)
      : undefined;
    const genres: string[] = Array.isArray(item.Genres) ? item.Genres : [];

    return {
      title,
      year: item.ProductionYear || undefined,
      poster,
      overview: item.Overview || undefined,
      runtimeMin: runtimeMin && runtimeMin > 0 ? runtimeMin : undefined,
      rating: typeof item.CommunityRating === 'number' ? item.CommunityRating : undefined,
      genres,
      status: { label: 'Available', state: 'ok' },
      actions: [
        { id: 'playInJellyfin', label: 'Play in Jellyfin', icon: '▶',
          kind: 'deeplink', actionId: 'playInJellyfin', params: { id }, variant: 'p' }
      ]
    };
  }
};
registerIntegration(jellyfin);
