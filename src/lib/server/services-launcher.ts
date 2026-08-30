import type { DB } from './db';
import { getSetting, setSetting } from './settings';
import { listConnectionsPublic } from './connections';
import { dockerRequest } from './docker';

export interface ServiceLink {
  name: string;
  url: string;
}

const SETTING_KEY = 'services_links';
const MAX_NAME = 100;
const MAX_URL = 500;

/** Return true if the string looks like an http(s) URL. */
function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Parse a link's URL into a `host:port` dedupe key, or null if unparseable. */
function hostPortKey(url: string): string | null {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port}`;
  } catch {
    return null;
  }
}

/**
 * Connection types that exist only to hold a credential — they are not services a person opens
 * in a browser, and their baseUrl is a machine API endpoint (or a placeholder that only exists
 * because config import rejects an empty one). They must never become a launcher tile, and must
 * never be picked as the Docker host.
 */
const NON_LAUNCHABLE_TYPES = new Set(['stremio']);

function launchable(c: { type: string; enabled: boolean; baseUrl: string }): boolean {
  return c.enabled && !NON_LAUNCHABLE_TYPES.has(c.type) && !!c.baseUrl && c.baseUrl.trim() !== '';
}

/** Compute the curated/derived links (saved setting OR connection-derived defaults). */
function baseLinks(db: DB): ServiceLink[] {
  const raw = getSetting(db, SETTING_KEY);
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as ServiceLink[];
    } catch {
      /* fall through to defaults */
    }
  }
  // Derive defaults from enabled connections that have a non-empty baseUrl.
  // Use the PUBLIC connection list so we never decrypt secrets just to discard them.
  return listConnectionsPublic(db)
    .filter(launchable)
    .map((c) => ({ name: c.name, url: c.baseUrl.trim() }));
}

/** Resolve the host used to build Docker container URLs, or null if unknown. */
function dockerHost(db: DB): string | null {
  const conn = listConnectionsPublic(db).find(launchable);
  if (conn) {
    try {
      return new URL(conn.baseUrl.trim()).hostname;
    } catch {
      /* fall through to env */
    }
  }
  return process.env.PULSE_HOST ?? null;
}

/** Best-effort: enumerate Docker containers that publish a web port and turn them into links. */
async function dockerLinks(db: DB): Promise<ServiceLink[]> {
  const host = dockerHost(db);
  if (!host) return [];
  const res = await dockerRequest('GET', '/containers/json');
  if (res.status < 200 || res.status >= 300 || !Array.isArray(res.data)) return [];
  const links: ServiceLink[] = [];
  for (const c of res.data as Array<{ Names?: string[]; Ports?: Array<{ PublicPort?: number; Type?: string }> }>) {
    const name = (c.Names?.[0] ?? '').replace(/^\//, '');
    if (!name || name === 'pulse') continue;
    const port = (c.Ports ?? []).find((p) => p.Type === 'tcp' && typeof p.PublicPort === 'number');
    if (!port) continue;
    links.push({ name, url: `http://${host}:${port.PublicPort}` });
  }
  return links;
}

/**
 * Get the curated service links from settings, or derive defaults from
 * enabled connections when the setting has not been set yet, then best-effort
 * merge in Docker containers that publish a web port. Deduped by `host:port`.
 * Any failure in the Docker branch returns the base links unchanged.
 */
export async function getServiceLinks(db: DB): Promise<ServiceLink[]> {
  const base = baseLinks(db);
  let extra: ServiceLink[] = [];
  try {
    extra = await dockerLinks(db);
  } catch {
    return base;
  }
  if (extra.length === 0) return base;
  const seen = new Set<string>();
  const merged: ServiceLink[] = [];
  for (const link of [...base, ...extra]) {
    const key = hostPortKey(link.url);
    if (key !== null) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    merged.push(link);
  }
  return merged;
}

/**
 * Validate and persist a curated list of service links. Invalid entries
 * (missing name, invalid URL, values exceeding length caps) are silently
 * dropped so callers don't need to pre-validate.
 */
export function setServiceLinks(db: DB, links: unknown[]): void {
  const cleaned: ServiceLink[] = [];
  for (const item of links) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name.trim().slice(0, MAX_NAME) : '';
    const url = typeof o.url === 'string' ? o.url.trim().slice(0, MAX_URL) : '';
    if (!name || !isHttpUrl(url)) continue;
    cleaned.push({ name, url });
  }
  setSetting(db, SETTING_KEY, JSON.stringify(cleaned));
}
