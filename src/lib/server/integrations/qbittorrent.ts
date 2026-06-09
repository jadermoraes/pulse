import type { Connection } from '../connections';
import type { Integration, WidgetResult } from './types';
import { registerIntegration } from './registry';

// Per-connection cookie cache: stores the full "name=value" string, e.g. "QBT_SID_8080=ABC123".
// Server-side only; never serialized to a widget result.
const sidCache = new Map<number, string>();
export function __resetSidCache(): void { sidCache.clear(); }

function base(conn: Connection): string { return conn.baseUrl.replace(/\/$/, ''); }
function username(conn: Connection): string {
  return String((conn.options as any)?.username ?? '');
}

// Parse the first cookie pair from a Set-Cookie header as "name=value".
// Handles any cookie name: QBT_SID_8080, SID, etc.
function parseCookie(setCookie: string): string {
  const m = setCookie.match(/^\s*([^=;\s]+)=([^;]+)/);
  return m ? `${m[1]}=${m[2]}` : '';
}

export async function login(conn: Connection): Promise<string> {
  const body = new URLSearchParams({ username: username(conn), password: conn.secret ?? '' });
  const res = await fetch(`${base(conn)}/api/v2/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  });
  const text = await res.text();
  // qBittorrent can respond with HTTP 200 + "Ok.", OR HTTP 204 with an empty body.
  // Wrong credentials are indicated by a 2xx response whose body is "Fails.".
  if (!res.ok || text.trim() === 'Fails.') throw new Error('Authentication failed');
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = parseCookie(setCookie);
  if (!cookie) throw new Error('Authentication failed');
  if (conn.id > 0) sidCache.set(conn.id, cookie);  // skip caching for unsaved test connections
  return cookie;
}

export async function ensureCookie(conn: Connection): Promise<string> {
  return sidCache.get(conn.id) ?? (await login(conn));
}

// POST a form body to a qBit endpoint with the cached cookie; re-auth once on 403.
async function authedSend(conn: Connection, path: string, form: Record<string, string>): Promise<void> {
  const body = new URLSearchParams(form).toString();
  let cookie = await ensureCookie(conn);
  const doPost = (c: string) => fetch(`${base(conn)}${path}`, {
    method: 'POST',
    headers: { Cookie: c, 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  let res = await doPost(cookie);
  if (res.status === 403) {
    sidCache.delete(conn.id);
    cookie = await login(conn);
    res = await doPost(cookie);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

// GET a qBit endpoint with the cached cookie; re-auth once on 403.
async function authedFetch(conn: Connection, path: string): Promise<Response> {
  let cookie = await ensureCookie(conn);
  let res = await fetch(`${base(conn)}${path}`, { headers: { Cookie: cookie } });
  if (res.status === 403) {
    sidCache.delete(conn.id);
    cookie = await login(conn);
    res = await fetch(`${base(conn)}${path}`, { headers: { Cookie: cookie } });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

export const qbittorrent: Integration = {
  type: 'qbittorrent', label: 'qBittorrent', icon: 'qbittorrent',
  configSchema: [
    { key: 'baseUrl', label: 'WebUI URL', type: 'url', required: true, placeholder: 'http://192.168.1.21:8080' },
    { key: 'username', label: 'Username', type: 'text', required: true, placeholder: 'admin' },
    { key: 'secret', label: 'Password', type: 'password', required: true }
  ],
  async testConnection(conn) {
    try {
      await login(conn);
      const res = await authedFetch(conn, '/api/v2/app/version');
      const version = (await res.text()).trim();
      return { ok: true, message: `Connected · qBittorrent ${version}`.trim() };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  },
  widgets: {
    async transfers(conn): Promise<WidgetResult> {
      try {
        const res = await authedFetch(conn, '/api/v2/transfer/info');
        const d = await res.json();
        return { ok: true, data: {
          dlSpeed: Number(d.dl_info_speed ?? 0),
          upSpeed: Number(d.up_info_speed ?? 0)
        } };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    },
    async torrents(conn): Promise<WidgetResult> {
      try {
        const res = await authedFetch(conn, '/api/v2/torrents/info?limit=20');
        const list = await res.json();
        const data = (list as any[]).map((t) => ({
          id: t.hash,
          name: t.name,
          progress: Math.round(Number(t.progress ?? 0) * 100),
          state: t.state ?? 'unknown',
          dlSpeed: Number(t.dlspeed ?? 0),
          upSpeed: Number(t.upspeed ?? 0)
        }));
        return { ok: true, data };
      } catch (e) {
        return { ok: false, error: (e as Error).message };
      }
    }
  },
  actions: {
    pause: { id: 'pause', label: '⏸  Pause', kind: 'download',
      async run(conn, params) {
        await authedSend(conn, '/api/v2/torrents/pause', { hashes: String(params.hash) });
        return { ok: true, message: 'Paused' };
      } },
    resume: { id: 'resume', label: '▶  Resume', kind: 'download',
      async run(conn, params) {
        await authedSend(conn, '/api/v2/torrents/resume', { hashes: String(params.hash) });
        return { ok: true, message: 'Resumed' };
      } },
    delete: { id: 'delete', label: '🗑  Remove & delete files', kind: 'download',
      async run(conn, params) {
        await authedSend(conn, '/api/v2/torrents/delete', { hashes: String(params.hash), deleteFiles: 'true' });
        return { ok: true, message: 'Removed' };
      } }
  }
};
registerIntegration(qbittorrent);
