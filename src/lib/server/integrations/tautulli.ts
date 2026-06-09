import type { Connection } from '../connections';
import type { Integration, WidgetResult, ImageRequest } from './types';
import { registerIntegration } from './registry';

// Tautulli v2: GET /api/v2?apikey=<key>&cmd=<command>. Key stays server-side (no header-auth option).
function cmdUrl(conn: Connection, cmd: string, extra: Record<string, string | number> = {}): string {
  const u = new URL(conn.baseUrl.replace(/\/$/, '') + '/api/v2');
  u.searchParams.set('apikey', conn.secret ?? '');
  u.searchParams.set('cmd', cmd);
  for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, String(v));
  return u.toString();
}

async function call(conn: Connection, cmd: string, extra: Record<string, string | number> = {}): Promise<any> {
  const res = await fetch(cmdUrl(conn, cmd, extra), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = await res.json();
  if (body?.response?.result !== 'success') throw new Error('Tautulli error');
  return body.response.data;
}

export const tautulli: Integration = {
  type: 'tautulli', label: 'Tautulli', icon: 'tautulli',
  configSchema: [
    { key: 'baseUrl', label: 'Server URL', type: 'url', required: true, placeholder: 'http://192.168.1.21:8181' },
    { key: 'secret', label: 'API Key', type: 'password', required: true }
  ],
  imageRequest(conn: Connection, path: string): ImageRequest {
    const base = conn.baseUrl.replace(/\/$/, '') + '/api/v2';
    const url =
      base +
      '?apikey=' + encodeURIComponent(conn.secret ?? '') +
      '&cmd=pms_image_proxy' +
      '&img=' + encodeURIComponent(path) +
      '&width=200&fallback=poster';
    return { url, headers: {} };
  },
  async testConnection(conn) {
    try {
      const info = await call(conn, 'get_server_info');
      return { ok: true, message: `Connected · Tautulli (${info.pms_name ?? 'Plex'})` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },
  widgets: {
    async activity(conn): Promise<WidgetResult> {
      try {
        const d = await call(conn, 'get_activity');
        const sessions = (d.sessions ?? []).map((s: any) => ({
          user: s.friendly_name ?? s.user ?? '—',
          title: s.full_title ?? s.title ?? '',
          progress: Math.round(Number(s.progress_percent ?? 0)),
          state: s.state ?? ''
        }));
        return { ok: true, data: { count: Number(d.stream_count ?? sessions.length), sessions } };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    async history(conn): Promise<WidgetResult> {
      try {
        const d = await call(conn, 'get_history', { length: 15 });
        const rows = (d.data ?? []).map((r: any) => ({
          user: r.friendly_name ?? '—',
          title: r.full_title ?? r.title ?? '',
          watched: Number(r.watched_status ?? 0) === 1
        }));
        return { ok: true, data: { total: Number(d.recordsFiltered ?? rows.length), rows } };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
  }
};
registerIntegration(tautulli);
