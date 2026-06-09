import type { Connection } from '../connections';
import type { Integration, WidgetResult } from './types';
import { registerIntegration } from './registry';

const TOKEN_HEADER = 'x-api-token';
const PATH_POPULAR = '/stats/getMostViewedByType';  // POST, requires {days, type}
const PATH_RECENT = '/api/getHistory';               // GET, returns {results: [...]}

function url(conn: Connection, path: string): string {
  return conn.baseUrl.replace(/\/$/, '') + path;
}

async function req(conn: Connection, path: string, method: 'GET' | 'POST', body?: unknown): Promise<any> {
  const init: RequestInit = {
    method,
    headers: { [TOKEN_HEADER]: conn.secret ?? '', Accept: 'application/json', 'Content-Type': 'application/json' }
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url(conn, path), init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Tolerate a bare array or a { results: [...] } envelope (real Jellystat /api/getHistory shape).
function rows(payload: any): any[] {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.results)) return payload.results;
  return [];
}

export const jellystat: Integration = {
  type: 'jellystat', label: 'Jellystat', icon: 'jellystat',
  configSchema: [
    { key: 'baseUrl', label: 'Server URL', type: 'url', required: true, placeholder: 'http://192.168.1.21:3000' },
    { key: 'secret', label: 'API Key', type: 'password', required: true }
  ],
  async testConnection(conn) {
    try {
      await req(conn, '/auth/isconfigured', 'GET');
      return { ok: true, message: 'Connected · Jellystat' };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },
  widgets: {
    async popular(conn): Promise<WidgetResult> {
      // Fetch movies and series separately (type is required; omitting it → 503).
      // Either call may fail; we use whatever succeeded.
      const TOP = 10;
      const days = 365;
      const results: any[][] = [];
      for (const type of ['Movie', 'Series'] as const) {
        try {
          const payload = await req(conn, PATH_POPULAR, 'POST', { days, type });
          if (Array.isArray(payload)) results.push(payload);
        } catch {
          // tolerate individual type failure — use the other
        }
      }
      const merged = results.flat();
      merged.sort((a, b) => Number(b.Plays ?? 0) - Number(a.Plays ?? 0));
      const data = merged.slice(0, TOP).map((r: any) => ({
        title: r.Name ?? '—',
        id: r.Id,
        plays: Number(r.Plays ?? 0)
      }));
      return { ok: true, data };
    },
    async recent(conn): Promise<WidgetResult> {
      try {
        const CAP = 20;
        const payload = await req(conn, PATH_RECENT, 'GET');
        const raw = rows(payload);  // parses {results:[...]} envelope
        const data = raw.slice(0, CAP).map((r: any) => ({
          title: r.SeriesName ? `${r.SeriesName} · ${r.NowPlayingItemName}` : (r.NowPlayingItemName ?? r.Name ?? '—'),
          user: r.UserName ?? '—',
          client: r.Client ?? '',
          device: r.DeviceName ?? '',
          when: r.ActivityDateInserted ?? ''
        }));
        return { ok: true, data: { items: data, count: raw.length } };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
  }
};
registerIntegration(jellystat);
