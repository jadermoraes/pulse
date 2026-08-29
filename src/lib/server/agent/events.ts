// src/lib/server/agent/events.ts
import type { DB } from '../db';
import { listConnections } from '../connections';
import { resolveWidget } from '../../widgets';
import { listContainers } from '../docker';
import { collectStats } from '../metrics';
import { getSetting } from '../settings';
import { notifyConsumer, notifyAdmins } from '../notify';
import { listPendingNotify, consumersAwaiting, markOnServer } from '../consumer/watchlist';
import { mirrorFavorite } from '../consumer/jellyfin-favorite';
import { joinUrl, getJsonWithKey } from '../http';
import { ingestPlays } from '../consumer/plays-ingest';
import { ingestJellystatPlays } from '../consumer/jellystat-ingest';
import { pollTraktHistory } from '../consumer/trakt-sync';
import { pollStremioSync } from '../consumer/stremio-sync';

export interface EventRow {
  id: number; ts: number; source: string; type: string;
  severity: 'info' | 'warn' | 'crit'; title: string; body: string | null;
  entityRef: unknown; suggestedActions: unknown; read: boolean;
}

export function listEvents(db: DB, opts: { unreadOnly?: boolean; limit?: number } = {}): EventRow[] {
  const limit = opts.limit ?? 30;
  const where = opts.unreadOnly ? 'where read=0' : '';
  const rows = db.prepare(
    `select * from events ${where} order by ts desc limit ?`
  ).all(limit) as any[];
  return rows.map((r) => ({
    id: r.id, ts: r.ts, source: r.source, type: r.type, severity: r.severity,
    title: r.title, body: r.body,
    entityRef: r.entity_ref ? JSON.parse(r.entity_ref) : null,
    suggestedActions: r.suggested_actions ? JSON.parse(r.suggested_actions) : null,
    read: !!r.read
  }));
}

export interface NormalizedEvent {
  source: string; type: string; title: string; body?: string;
  severity: 'info' | 'warn' | 'crit';
  dedupeKey: string;
  entityRef?: unknown;
  suggestedActions?: unknown;
  cooldownMs?: number;
  /** If true, the event fires at most once per dedupeKey ever (ignores cooldown). */
  onceEver?: boolean;
}

const DEFAULT_COOLDOWN = 30 * 60 * 1000; // 30 min

/** Delete read events older than `olderThanMs` ms (default 7 days) to keep the table tidy. */
export function pruneEvents(db: DB, olderThanMs = 7 * 24 * 60 * 60 * 1000): number {
  const cutoff = Date.now() - olderThanMs;
  const info = db.prepare('DELETE FROM events WHERE read=1 AND ts < ?').run(cutoff);
  return Number(info.changes);
}

/** Insert a normalized event unless an identical dedupeKey exists within the cooldown. Returns id (0 = deduped). */
export function recordEvent(db: DB, ev: NormalizedEvent): number {
  if (ev.onceEver) {
    // Fire-once semantics: check the persistent ledger, not the prunable events table.
    const seen = db.prepare(
      'select dedupe_key from seen_events where dedupe_key=?'
    ).get(ev.dedupeKey) as { dedupe_key: string } | undefined;
    if (seen) return 0;
    // Not seen yet — record in ledger first (INSERT OR IGNORE is idempotent under races).
    db.prepare(
      'INSERT OR IGNORE INTO seen_events(dedupe_key, first_ts) VALUES (?, ?)'
    ).run(ev.dedupeKey, Date.now());
  } else {
    const existing = db.prepare(
      'select ts from events where dedupe_key=? order by ts desc limit 1'
    ).get(ev.dedupeKey) as { ts: number } | undefined;
    const cooldown = ev.cooldownMs ?? DEFAULT_COOLDOWN;
    if (existing && Date.now() - existing.ts < cooldown) return 0;
  }
  const info = db.prepare(
    `insert into events(ts,source,type,severity,title,body,entity_ref,suggested_actions,read,dedupe_key)
     values (?,?,?,?,?,?,?,?,0,?)`
  ).run(
    Date.now(), ev.source, ev.type, ev.severity, ev.title, ev.body ?? null,
    ev.entityRef ? JSON.stringify(ev.entityRef) : null,
    ev.suggestedActions ? JSON.stringify(ev.suggestedActions) : null,
    ev.dedupeKey
  );
  return Number(info.lastInsertRowid);
}

export function markRead(db: DB, ids: number[]): void {
  if (!ids.length) return;
  const stmt = db.prepare('update events set read=1 where id=?');
  const tx = db.transaction((list: number[]) => { for (const id of list) stmt.run(id); });
  tx(ids);
}

/** Mark every unread event as read (bulk clear-all). */
export function markAllRead(db: DB): void {
  db.prepare('update events set read=1 where read=0').run();
}

export const severityOf = {
  disk(percent: number): 'info' | 'warn' | 'crit' {
    if (percent >= 90) return 'crit';
    if (percent >= 80) return 'warn';
    return 'info';
  }
};

const DISK_THRESHOLD = Number(process.env.PULSE_DISK_WARN ?? 80);

type OpsEventType = 'container_down' | 'disk_high' | 'download_stalled';

/** Returns true when admin notifications are enabled for the given ops event type.
 *  Reads the 'notify_prefs' setting (JSON object keyed by type → boolean).
 *  Defaults to true when the setting is unset or the type key is absent. */
export function opsNotifyEnabled(db: DB, type: OpsEventType): boolean {
  const raw = getSetting(db, 'notify_prefs');
  if (!raw) return true;
  try {
    const prefs = JSON.parse(raw) as Record<string, boolean>;
    return prefs[type] !== false;
  } catch {
    return true;
  }
}

/**
 * Poll all sources best-effort and record new events. Each source is isolated:
 * a thrown source is swallowed so the others still run.
 */
export async function pollEvents(db: DB): Promise<void> {
  const conns = listConnections(db).filter((c) => c.enabled);

  // --- containers down ---
  try {
    const { available, containers } = await listContainers();
    if (available) {
      for (const c of containers) {
        if (c.state === 'exited' || c.state === 'dead') {
          const ev = {
            source: 'docker', type: 'container_down' as const, severity: 'crit' as const,
            title: `${c.name} is ${c.state}`, body: c.status,
            dedupeKey: `container_down:${c.name}`,
            entityRef: { kind: 'container', id: c.id },
            suggestedActions: [{ label: 'Restart', tool: 'restartContainer', args: { id: c.id } }]
          };
          const id = recordEvent(db, ev);
          if (id && opsNotifyEnabled(db, 'container_down')) {
            await notifyAdmins(db, { title: ev.title, body: ev.body ?? '' }).catch(() => { /* best-effort */ });
          }
        }
      }
    }
  } catch { /* docker source silent */ }

  // --- disk pressure ---
  try {
    const stats = await collectStats({ sampleMs: 1 });
    for (const d of stats.disks ?? []) {
      if (d.percent >= DISK_THRESHOLD) {
        const severity = severityOf.disk(d.percent);
        const ev = {
          source: 'system', type: 'disk_high' as const, severity,
          title: `Disk ${d.mount} at ${d.percent}%`,
          dedupeKey: `disk_high:${d.mount}`,
          cooldownMs: 6 * 60 * 60 * 1000, // 6 hours — disk alerts are noisy at the default 30-min cadence
          entityRef: { kind: 'disk', id: d.mount }
        };
        const id = recordEvent(db, ev);
        if (id && (severity === 'warn' || severity === 'crit') && opsNotifyEnabled(db, 'disk_high')) {
          await notifyAdmins(db, { title: ev.title, body: '' }).catch(() => { /* best-effort */ });
        }
      }
    }
  } catch { /* metrics source silent */ }

  // --- per-connection sources (downloads stalled, requests available) ---
  for (const conn of conns) {
    try {
      if (conn.type === 'radarr' || conn.type === 'sonarr') {
        const r = await resolveWidget(db, conn.id, 'queue');
        if (r.ok && Array.isArray(r.data)) {
          for (const row of r.data as any[]) {
            if (String(row.status).toLowerCase() === 'stalled' || row.progress === 0 && String(row.status).toLowerCase() === 'warning') {
              const stallEv = {
                source: conn.name, type: 'download_stalled' as const, severity: 'warn' as const,
                title: `Download stalled: ${row.title}`,
                dedupeKey: `download_stalled:${conn.id}:${row.id}`,
                entityRef: { connectionId: conn.id, kind: conn.type === 'sonarr' ? 'series' : 'movie', id: row.id }
              };
              const stallId = recordEvent(db, stallEv);
              if (stallId && opsNotifyEnabled(db, 'download_stalled')) {
                await notifyAdmins(db, { title: stallEv.title, body: '' }).catch(() => { /* best-effort */ });
              }
            }
          }
        }
      }
      if (conn.type === 'seerr') {
        const r = await resolveWidget(db, conn.id, 'requests');
        if (r.ok && Array.isArray(r.data)) {
          for (const req of r.data as any[]) {
            if (req.status === 'Available') {
              recordEvent(db, {
                source: conn.name, type: 'request_available', severity: 'info',
                title: `Now available: ${req.title}`,
                dedupeKey: `request_available:${conn.id}:${req.id}`,
                entityRef: { connectionId: conn.id, kind: 'request', id: req.id },
                onceEver: true
              });
              // D.3: mark the consumer's tracked request available + one-shot web push.
              const tracked = db.prepare(
                'select id, consumer_id, notified, title from consumer_requests where seerr_request_id=?'
              ).get(req.id) as { id: number; consumer_id: number; notified: number; title: string } | undefined;
              if (tracked) {
                db.prepare("update consumer_requests set status='available' where seerr_request_id=?").run(req.id);
                if (!tracked.notified) {
                  await notifyConsumer(db, tracked.consumer_id, {
                    title: 'Ready to watch', body: `${tracked.title} is now available`, url: '/app/requests'
                  }).catch(() => { /* notify best-effort */ });
                  db.prepare('update consumer_requests set notified=1 where seerr_request_id=?').run(req.id);
                }
              }
            }
          }
        }
      }
    } catch { /* this connection silent; others continue */ }
  }
}

/**
 * For each distinct pending watchlist title, ask seerr if it's now available (mediaInfo.status===5).
 * When it is: notify every awaiting consumer once, flip their row on-server, and mirror into their
 * Jellyfin Favorites. Best-effort end-to-end — a failure on one title never blocks the others.
 */
export async function pollWatchlistAvailability(db: DB): Promise<void> {
  const seerr = listConnections(db).find((c) => c.type === 'seerr' && c.enabled);
  if (!seerr) return;
  for (const { tmdbId, mediaType } of listPendingNotify(db)) {
    try {
      const path = mediaType === 'tv' ? `/api/v1/tv/${tmdbId}` : `/api/v1/movie/${tmdbId}`;
      const d = await getJsonWithKey(joinUrl(seerr.baseUrl, path), seerr.secret);
      if (d?.mediaInfo?.status !== 5) continue;
      for (const row of consumersAwaiting(db, tmdbId, mediaType)) {
        await notifyConsumer(db, row.consumerId, {
          title: 'Ready to watch', body: `${row.title} is now available`, url: '/app'
        }).catch(() => { /* notify best-effort */ });
        markOnServer(db, row.consumerId, tmdbId, mediaType, null);
        await mirrorFavorite(db, row.consumerId, tmdbId, mediaType, true).catch(() => { /* best-effort */ });
      }
    } catch { /* this title silent; others continue */ }
  }
}

let _timer: ReturnType<typeof setInterval> | null = null;
const POLL_MS = Number(process.env.PULSE_EVENT_POLL_MS ?? 120000);

/**
 * Run pollEvents but never let two runs overlap: if a previous run is still in flight when
 * the next tick fires, skip this tick. A slow poll (e.g. a hung upstream) otherwise stacks up.
 */
let _running = false;
export async function tickPoll(db: DB): Promise<void> {
  if (_running) return;
  _running = true;
  try {
    await pollEvents(db);
    const tautulli = listConnections(db).find((c) => c.type === 'tautulli' && c.enabled);
    if (tautulli) await ingestPlays(db, tautulli).catch(() => { /* best-effort */ });
    const jellystat = listConnections(db).find((c) => c.type === 'jellystat' && c.enabled);
    const jellyfin = listConnections(db).find((c) => c.type === 'jellyfin' && c.enabled);
    if (jellystat && jellyfin) {
      await ingestJellystatPlays(db, jellystat, jellyfin).catch(() => { /* best-effort */ });
    }
    await pollWatchlistAvailability(db);
    await pollStremioSync(db).catch(() => { /* best-effort */ });
    await pollTraktHistory(db).catch(() => { /* best-effort */ });
    pruneEvents(db); // remove read events older than 7 days to keep the table trim
  }
  catch { /* swallowed: each source is already isolated inside pollEvents */ }
  finally { _running = false; }
}

/** Start the background poller exactly once (idempotent). Safe no-op under tests. */
export function startEventPoller(db: DB): void {
  if (_timer || process.env.PULSE_DISABLE_POLLER === '1') return;
  // fire once shortly after boot, then on the interval
  setTimeout(() => { void tickPoll(db); }, 5000);
  _timer = setInterval(() => { void tickPoll(db); }, POLL_MS);
}
