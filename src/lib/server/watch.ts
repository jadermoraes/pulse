/**
 * watch.ts — server-only normalization helpers for the unified watch view.
 * Aggregates active streams and history from all enabled Jellyfin/Tautulli/Jellystat connections.
 * Secrets are never included in any output shape.
 */

import type { Connection } from './connections';

// ---------------------------------------------------------------------------
// Normalized shapes
// ---------------------------------------------------------------------------

export interface NowPlayingStream {
  server: string;
  serverType: 'jellyfin' | 'plex';
  user: string;
  title: string;
  subtitle?: string;
  mediaType?: string;
  progressPercent: number; // 0-100, rounded
  state: 'playing' | 'paused';
  /** Pulse-proxied poster URL, e.g. /api/image/<connId>?path=... — null if unavailable. */
  poster: string | null;
}

export interface WatchHistoryItem {
  server: string;
  serverType: 'plex' | 'jellyfin';
  user: string;
  title: string;
  mediaType?: string;
  when: string; // ISO string
  /** Pulse-proxied poster URL, e.g. /api/image/<connId>?path=... — null if unavailable. */
  poster: string | null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Build a Pulse-proxied poster URL through the Jellyfin image proxy. Never leaks secret. */
function jellyfinPoster(connId: number, itemId: string): string {
  return `/api/image/${connId}?path=${encodeURIComponent(`/Items/${itemId}/Images/Primary?fillHeight=160`)}`;
}

/** Build a Pulse-proxied poster URL through the Tautulli pms_image_proxy. Never leaks secret. */
function tautulliPoster(connId: number, thumbPath: string): string {
  return `/api/image/${connId}?path=${encodeURIComponent(thumbPath)}`;
}

// ---------------------------------------------------------------------------
// Jellyfin: active sessions
// ---------------------------------------------------------------------------

export async function fetchJellyfinStreams(conn: Connection): Promise<NowPlayingStream[]> {
  const u = new URL(conn.baseUrl.replace(/\/$/, '') + '/Sessions');
  u.searchParams.set('api_key', conn.secret ?? '');
  const res = await fetch(u.toString());
  if (!res.ok) throw new Error(`Jellyfin HTTP ${res.status}`);
  const sessions: any[] = await res.json();
  return sessions
    .filter((s) => s.NowPlayingItem)
    .map((s) => {
      const item = s.NowPlayingItem;
      const runTicks: number = item.RunTimeTicks ?? 0;
      const posTicks: number = s.PlayState?.PositionTicks ?? 0;
      const progressPercent = runTicks > 0 ? Math.round((posTicks / runTicks) * 100) : 0;
      const isPaused: boolean = s.PlayState?.IsPaused ?? false;

      const itemId: string | null = item.Id ?? null;
      const poster = itemId ? jellyfinPoster(conn.id, itemId) : null;

      const stream: NowPlayingStream = {
        server: conn.name,
        serverType: 'jellyfin',
        user: s.UserName ?? '—',
        title: item.SeriesName ? `${item.SeriesName} · ${item.Name}` : (item.Name ?? '—'),
        mediaType: item.Type ?? undefined,
        progressPercent,
        state: isPaused ? 'paused' : 'playing',
        poster
      };
      return stream;
    });
}

// ---------------------------------------------------------------------------
// Tautulli: active sessions
// ---------------------------------------------------------------------------

export async function fetchTautulliStreams(conn: Connection): Promise<NowPlayingStream[]> {
  const u = new URL(conn.baseUrl.replace(/\/$/, '') + '/api/v2');
  u.searchParams.set('apikey', conn.secret ?? '');
  u.searchParams.set('cmd', 'get_activity');
  const res = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Tautulli HTTP ${res.status}`);
  const body = await res.json();
  if (body?.response?.result !== 'success') throw new Error('Tautulli error');
  const data = body.response.data;
  const sessions: any[] = data?.sessions ?? [];
  return sessions.map((s) => {
    // For episodes use grandparent_thumb (show poster), otherwise use thumb
    const thumbPath: string | null =
      (s.media_type === 'episode'
        ? (s.grandparent_thumb || s.thumb)
        : (s.thumb || s.grandparent_thumb)) || null;
    const poster = thumbPath ? tautulliPoster(conn.id, thumbPath) : null;
    return {
      server: conn.name,
      serverType: 'plex' as const,
      user: s.friendly_name ?? s.user ?? '—',
      title: s.full_title ?? s.title ?? '—',
      mediaType: s.media_type ?? undefined,
      progressPercent: Math.round(Number(s.progress_percent ?? 0)),
      state: s.state === 'paused' ? 'paused' : 'playing',
      poster
    };
  });
}

// ---------------------------------------------------------------------------
// Tautulli: history
// ---------------------------------------------------------------------------

export async function fetchTautulliHistory(conn: Connection, length = 15): Promise<WatchHistoryItem[]> {
  const u = new URL(conn.baseUrl.replace(/\/$/, '') + '/api/v2');
  u.searchParams.set('apikey', conn.secret ?? '');
  u.searchParams.set('cmd', 'get_history');
  u.searchParams.set('length', String(length));
  const res = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Tautulli HTTP ${res.status}`);
  const body = await res.json();
  if (body?.response?.result !== 'success') throw new Error('Tautulli error');
  const rows: any[] = body.response.data?.data ?? [];
  // Exclude in-progress sessions: Tautulli sets stopped=0 (or null) while playing.
  // Those appear in Now Playing; Recently Watched should show only completed plays.
  const completed = rows.filter((r) => Boolean(r.stopped));
  return completed.map((r) => {
    const epochMs = Number(r.date ?? 0) * 1000;
    const when = epochMs > 0 ? new Date(epochMs).toISOString() : new Date(0).toISOString();
    const series = r.grandparent_title;
    const title = series
      ? `${series} · ${r.full_title ?? r.title ?? '—'}`
      : (r.full_title ?? r.title ?? '—');
    // For episodes use grandparent_thumb (show poster), otherwise use thumb
    const thumbPath: string | null =
      (r.media_type === 'episode'
        ? (r.grandparent_thumb || r.thumb)
        : (r.thumb || r.grandparent_thumb)) || null;
    const poster = thumbPath ? tautulliPoster(conn.id, thumbPath) : null;
    return {
      server: conn.name,
      serverType: 'plex' as const,
      user: r.friendly_name ?? r.user ?? '—',
      title,
      mediaType: r.media_type ?? undefined,
      when,
      poster
    };
  });
}

// ---------------------------------------------------------------------------
// Jellystat: history
// ---------------------------------------------------------------------------

export async function fetchJellystatHistory(
  conn: Connection,
  jellyfinConnId: number | null = null
): Promise<WatchHistoryItem[]> {
  const u = conn.baseUrl.replace(/\/$/, '') + '/api/getHistory';
  const res = await fetch(u, {
    headers: { 'x-api-token': conn.secret ?? '', Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`Jellystat HTTP ${res.status}`);
  const payload = await res.json();
  const rows: any[] = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.results)
    ? payload.results
    : [];
  return rows.map((r) => {
    const title = r.SeriesName
      ? `${r.SeriesName} · ${r.NowPlayingItemName ?? '—'}`
      : (r.NowPlayingItemName ?? r.Name ?? '—');
    // Use the Jellyfin item id to build a poster URL via the Jellyfin connection
    const itemId: string | null = r.NowPlayingItemId ?? r.Id ?? null;
    const poster =
      itemId && jellyfinConnId !== null
        ? jellyfinPoster(jellyfinConnId, itemId)
        : null;
    return {
      server: conn.name,
      serverType: 'jellyfin' as const,
      user: r.UserName ?? '—',
      title,
      when: r.ActivityDateInserted ?? new Date(0).toISOString(),
      poster
    };
  });
}

// ---------------------------------------------------------------------------
// Jellystat: most-watched
// ---------------------------------------------------------------------------

export interface MostWatchedItem {
  server: string;
  serverType: 'plex' | 'jellyfin';
  title: string;
  plays: number;
  /** Pulse-proxied poster URL — null if unavailable. */
  poster: string | null;
}

export async function fetchTautulliMostWatched(conn: Connection): Promise<MostWatchedItem[]> {
  const u = new URL(conn.baseUrl.replace(/\/$/, '') + '/api/v2');
  u.searchParams.set('apikey', conn.secret ?? '');
  u.searchParams.set('cmd', 'get_home_stats');
  u.searchParams.set('time_range', '30');
  u.searchParams.set('stats_count', '10');
  const res = await fetch(u.toString(), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Tautulli HTTP ${res.status}`);
  const body = await res.json();
  if (body?.response?.result !== 'success') throw new Error('Tautulli error');
  const stats: any[] = body.response.data ?? [];
  const items: MostWatchedItem[] = [];
  for (const stat of stats) {
    if (stat.stat_id !== 'top_movies' && stat.stat_id !== 'top_tv') continue;
    const rows: any[] = stat.rows ?? [];
    for (const r of rows) {
      const thumbPath: string | null =
        (r.grandparent_thumb || r.thumb) || null;
      const poster = thumbPath ? tautulliPoster(conn.id, thumbPath) : null;
      items.push({
        server: conn.name,
        serverType: 'plex',
        title: r.title ?? '—',
        plays: Number(r.total_plays ?? 0),
        poster
      });
    }
  }
  return items;
}

export async function fetchJellystatMostWatched(
  conn: Connection,
  jellyfinConnId: number | null = null
): Promise<MostWatchedItem[]> {
  const items: MostWatchedItem[] = [];
  for (const type of ['Movie', 'Series'] as const) {
    try {
      const u = conn.baseUrl.replace(/\/$/, '') + '/stats/getMostViewedByType';
      const res = await fetch(u, {
        method: 'POST',
        headers: {
          'x-api-token': conn.secret ?? '',
          Accept: 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ days: 365, type })
      });
      if (!res.ok) throw new Error(`Jellystat HTTP ${res.status}`);
      const payload = await res.json();
      const rows: any[] = Array.isArray(payload) ? payload : [];
      for (const r of rows) {
        const itemId: string | null = r.Id ?? null;
        const poster =
          itemId && jellyfinConnId !== null
            ? jellyfinPoster(jellyfinConnId, itemId)
            : null;
        items.push({
          server: conn.name,
          serverType: 'jellyfin',
          title: r.Name ?? '—',
          plays: Number(r.Plays ?? 0),
          poster
        });
      }
    } catch {
      // tolerate individual type failure — use the other
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Aggregate helpers — used by the API route handlers
// ---------------------------------------------------------------------------

/**
 * Fetch active streams from all enabled Jellyfin + Tautulli connections.
 * A failing connection is silently skipped.
 */
export async function aggregateNowPlaying(
  connections: Connection[]
): Promise<{ count: number; streams: NowPlayingStream[] }> {
  const enabled = connections.filter((c) => c.enabled);
  const fetchers = enabled.map(async (conn) => {
    try {
      if (conn.type === 'jellyfin') return await fetchJellyfinStreams(conn);
      if (conn.type === 'tautulli') return await fetchTautulliStreams(conn);
    } catch {
      // skip unreachable connections
    }
    return [] as NowPlayingStream[];
  });
  const results = await Promise.all(fetchers);
  const streams = results.flat();
  return { count: streams.length, streams };
}

/**
 * Fetch history from all enabled Tautulli + Jellystat connections,
 * merge + sort by `when` desc, return top N items.
 */
export async function aggregateWatchHistory(
  connections: Connection[],
  cap = 15
): Promise<{ count: number; items: WatchHistoryItem[] }> {
  const enabled = connections.filter((c) => c.enabled);
  // Find the first enabled Jellyfin connection for Jellystat poster routing
  const jellyfinConn = enabled.find((c) => c.type === 'jellyfin') ?? null;
  const jellyfinConnId = jellyfinConn?.id ?? null;
  const fetchers = enabled.map(async (conn) => {
    try {
      if (conn.type === 'tautulli') return await fetchTautulliHistory(conn, cap);
      if (conn.type === 'jellystat') return await fetchJellystatHistory(conn, jellyfinConnId);
    } catch {
      // skip unreachable connections
    }
    return [] as WatchHistoryItem[];
  });
  const results = await Promise.all(fetchers);
  const all = results.flat();
  all.sort((a, b) => new Date(b.when).getTime() - new Date(a.when).getTime());
  const items = all.slice(0, cap);
  return { count: items.length, items };
}

/**
 * Fetch most-watched items from all enabled Tautulli + Jellystat connections,
 * merge + sort by plays desc, return top N items.
 */
export async function aggregateMostWatched(
  connections: Connection[],
  cap = 15
): Promise<{ count: number; items: MostWatchedItem[] }> {
  const enabled = connections.filter((c) => c.enabled);
  // Find the first enabled Jellyfin connection for Jellystat poster routing
  const jellyfinConn = enabled.find((c) => c.type === 'jellyfin') ?? null;
  const jellyfinConnId = jellyfinConn?.id ?? null;
  const fetchers = enabled.map(async (conn) => {
    try {
      if (conn.type === 'tautulli') return await fetchTautulliMostWatched(conn);
      if (conn.type === 'jellystat') return await fetchJellystatMostWatched(conn, jellyfinConnId);
    } catch {
      // skip unreachable connections
    }
    return [] as MostWatchedItem[];
  });
  const results = await Promise.all(fetchers);
  const all = results.flat();
  all.sort((a, b) => b.plays - a.plays);
  const items = all.slice(0, cap);
  return { count: items.length, items };
}
