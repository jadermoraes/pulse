import type { Connection } from '../connections';
import { joinUrl } from '../http';
import { ensureCookie as qbitEnsureCookie } from '../integrations/qbittorrent';
import { defaultTransport, type PveTransport } from '../integrations/proxmox';

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  query?: Record<string, string | number>;
  body?: unknown;
}
export interface ApiResult { status: number; data: unknown; }

// Services authenticated by an X-Api-Key header (the *arr apps + jellyseerr).
const HEADER_KEY_TYPES = new Set(['radarr', 'sonarr', 'seerr', 'prowlarr']);

async function doFetch(url: string, init: RequestInit): Promise<ApiResult> {
  const res = await fetch(url, init);
  let data: unknown;
  try { data = await res.json(); } catch { data = {}; }
  return { status: res.status, data };
}

/**
 * JSON-encode a body WITHOUT double-encoding. The model often passes `body` as an already
 * JSON-stringified string (e.g. '{"name":"SeriesSearch"}'); JSON.stringify-ing that again sends a
 * quoted blob the service rejects (Sonarr /api/v3/command → 400). So: a string that parses as JSON
 * is sent as-is; anything else is stringified normally.
 */
export function jsonBody(body: unknown): string {
  if (typeof body === 'string') {
    try { JSON.parse(body); return body; } catch { return JSON.stringify(body); }
  }
  return JSON.stringify(body);
}

/** Attach a JSON body only when there's a body and it's not a GET. */
function withBody(init: RequestInit, req: ApiRequest): RequestInit {
  if (req.body !== undefined && req.method !== 'GET') {
    init.body = jsonBody(req.body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  return init;
}

/**
 * x-www-form-urlencode a body. qBittorrent's WebUI API (/api/v2/*) is form-based, not JSON.
 * Accepts a plain object of fields, or a JSON string (the model sometimes passes the body as a
 * stringified object) which we parse first. A non-JSON string is sent through unchanged.
 */
function formEncode(body: unknown): string {
  let obj: unknown = body;
  if (typeof body === 'string') {
    try { obj = JSON.parse(body); } catch { return body; }
  }
  if (obj && typeof obj === 'object') {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      params.set(k, typeof v === 'string' ? v : JSON.stringify(v));
    }
    return params.toString();
  }
  return String(obj ?? '');
}

/**
 * Generic authenticated API call to a configured connection. Resolves base URL + injects the
 * service's auth server-side; the caller (and the LLM) never handle the secret. Returns
 * { status, data } for ANY HTTP status (never throws on a non-2xx) so the agent can react.
 * Returns { status: 0, data: { error } } for unsupported types / transport errors.
 */
export async function connectionApiRequest(
  conn: Connection,
  req: ApiRequest
): Promise<ApiResult> {
  try {
    if (HEADER_KEY_TYPES.has(conn.type)) {
      const url = joinUrl(conn.baseUrl, req.path, req.query ?? {});
      return await doFetch(url, withBody({ method: req.method, headers: { 'X-Api-Key': conn.secret ?? '', Accept: 'application/json' } }, req));
    }
    if (conn.type === 'jellyfin' || conn.type === 'plex') {
      const header = conn.type === 'jellyfin' ? 'X-Emby-Token' : 'X-Plex-Token';
      const url = joinUrl(conn.baseUrl, req.path, req.query ?? {});
      return await doFetch(url, withBody({ method: req.method, headers: { [header]: conn.secret ?? '', Accept: 'application/json' } }, req));
    }
    if (conn.type === 'tautulli') {
      const url = joinUrl(conn.baseUrl, req.path, { ...(req.query ?? {}), apikey: conn.secret ?? '' });
      return await doFetch(url, withBody({ method: req.method, headers: { Accept: 'application/json' } }, req));
    }
    if (conn.type === 'jellystat') {
      const url = joinUrl(conn.baseUrl, req.path, req.query ?? {});
      return await doFetch(url, withBody({ method: req.method, headers: { 'x-api-token': conn.secret ?? '', Accept: 'application/json' } }, req));
    }
    if (conn.type === 'qbittorrent') {
      // Reuse the integration's ensureCookie() — returns the cached "name=value" session
      // cookie (e.g. "SID=abc") or logs in via /api/v2/auth/login — then send it on the request.
      // TODO(v1): no stale-cookie 403 re-auth here — the agent sees the 403 and can retry.
      const cookie = await qbitEnsureCookie(conn);
      const url = joinUrl(conn.baseUrl, req.path, req.query ?? {});
      const init: RequestInit = { method: req.method, headers: { Cookie: cookie, Accept: 'application/json' } };
      if (req.body !== undefined && req.method !== 'GET') {
        init.body = formEncode(req.body);
        (init.headers as Record<string, string>)['Content-Type'] = 'application/x-www-form-urlencoded';
      }
      return await doFetch(url, init);
    }
    if (conn.type === 'proxmox') {
      return await pvePassthrough(conn, req);
    }
    return { status: 0, data: { error: `Service type "${conn.type}" does not support direct API control yet.` } };
  } catch (e) {
    return { status: 0, data: { error: `Request failed: ${(e as Error).message}` } };
  }
}

/**
 * Proxmox passthrough. Split out from {@link connectionApiRequest} so the transport seam stays
 * off the public dispatcher signature — mirrors how proxmox.ts injects at `pveGet(..., transport)`.
 * The `transport` default is for test injection only; production callers go through
 * connectionApiRequest with no 3rd arg.
 */
export async function pvePassthrough(
  conn: Connection,
  req: ApiRequest,
  transport: PveTransport = defaultTransport
): Promise<ApiResult> {
  // Proxmox uses a self-signed cert, so reuse the integration's node:https transport
  // (rejectUnauthorized:false) and its exact PVEAPIToken auth header. Path is taken as-is.
  const tokenId = String((conn.options as any)?.tokenId ?? '');
  const url = new URL(conn.baseUrl.replace(/\/$/, '') + req.path);
  for (const [k, v] of Object.entries(req.query ?? {})) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = {
    Authorization: `PVEAPIToken=${tokenId}=${conn.secret ?? ''}`,
    Accept: 'application/json'
  };
  let body: string | undefined;
  if (req.body !== undefined && req.method !== 'GET') {
    body = jsonBody(req.body);
    headers['Content-Type'] = 'application/json';
  }
  const { status, body: raw } = await transport.request({
    protocol: url.protocol,
    hostname: url.hostname,
    port: Number(url.port) || (url.protocol === 'https:' ? 443 : 80),
    path: url.pathname + url.search,
    headers,
    timeoutMs: 8_000,
    method: req.method,
    body
  });
  let data: unknown;
  try { data = JSON.parse(raw); } catch { data = {}; }
  return { status, data };
}
