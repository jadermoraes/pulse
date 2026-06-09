import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { recordEvent, listEvents, markRead, markAllRead, pruneEvents, severityOf, tickPoll, pollWatchlistAvailability, type NormalizedEvent } from './events';
import { createConnection } from '../connections';
import { addWatchlist, listWatchlist } from '../consumer/watchlist';
import * as notify from '../notify';

// Mock the slow sources pollEvents calls so we can control timing in the overlap test.
// NB: '../connections' is intentionally NOT mocked — pollWatchlistAvailability needs the real
// listConnections so the seerr connection created in tests is visible. The existing overlap /
// pollEvents tests create no connections, so real listConnections returns [] for them too.
vi.mock('../docker', () => ({
  listContainers: vi.fn(async () => {
    await new Promise((r) => setTimeout(r, 50)); // simulate a slow upstream
    return { available: false, containers: [] };
  })
}));
vi.mock('../metrics', () => ({ collectStats: vi.fn(async () => ({ disks: [] })) }));
vi.mock('../../widgets', () => ({ resolveWidget: vi.fn(async () => ({ ok: false })) }));

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });
afterEach(() => vi.useRealTimers());

const base: NormalizedEvent = {
  source: 'docker', type: 'container_down', title: 'jellyfin is down',
  body: 'exited', severity: 'crit', dedupeKey: 'container_down:jellyfin',
  entityRef: { kind: 'container', id: 'jellyfin' }, suggestedActions: [{ label: 'Restart', tool: 'restartContainer', args: { id: 'jellyfin' } }]
};

describe('events', () => {
  it('inserts a new event and lists it', () => {
    const id = recordEvent(db, base);
    expect(id).toBeGreaterThan(0);
    const rows = listEvents(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: 'container_down', severity: 'crit', read: false });
    expect((rows[0].suggestedActions as any)[0].tool).toBe('restartContainer');
  });

  it('dedupes within the cooldown window (same key → no new row)', () => {
    recordEvent(db, base);
    const second = recordEvent(db, base);     // immediate repeat
    expect(second).toBe(0);                    // 0 = deduped, not inserted
    expect(listEvents(db, {})).toHaveLength(1);
  });

  it('re-inserts after the cooldown elapses', () => {
    vi.useFakeTimers();
    recordEvent(db, { ...base, cooldownMs: 1000 });
    vi.advanceTimersByTime(2000);
    const again = recordEvent(db, { ...base, cooldownMs: 1000 });
    expect(again).toBeGreaterThan(0);
    expect(listEvents(db, {})).toHaveLength(2);
  });

  it('severityOf maps disk usage to a tier', () => {
    expect(severityOf.disk(95)).toBe('crit');
    expect(severityOf.disk(85)).toBe('warn');
    expect(severityOf.disk(50)).toBe('info');
  });

  it('markRead flips the read flag', () => {
    const id = recordEvent(db, base);
    markRead(db, [id]);
    expect(listEvents(db, { unreadOnly: true })).toHaveLength(0);
  });

  // Bug 1 — request_available fires exactly once per dedupeKey (onceEver)
  it('onceEver: fires once and never re-fires even well past cooldown', () => {
    vi.useFakeTimers();
    const avEvent: NormalizedEvent = {
      source: 'seerr', type: 'request_available', severity: 'info',
      title: 'Now available: Dune', dedupeKey: 'request_available:conn1:42',
      onceEver: true
    };
    const first = recordEvent(db, avEvent);
    expect(first).toBeGreaterThan(0);
    // Advance well beyond any cooldown
    vi.advanceTimersByTime(100 * 365 * 24 * 60 * 60 * 1000);
    const second = recordEvent(db, avEvent);
    expect(second).toBe(0);
    expect(listEvents(db, {})).toHaveLength(1);
  });

  it('onceEver does not affect regular cooldown events', () => {
    vi.useFakeTimers();
    recordEvent(db, { ...base, cooldownMs: 1000 });
    vi.advanceTimersByTime(2000);
    const again = recordEvent(db, { ...base, cooldownMs: 1000 });
    expect(again).toBeGreaterThan(0);
    expect(listEvents(db, {})).toHaveLength(2);
  });

  // Bug 2 — markAllRead clears every unread event
  it('markAllRead marks all unread events read regardless of count', () => {
    recordEvent(db, base);
    recordEvent(db, { ...base, dedupeKey: 'container_down:plex', title: 'plex is down' });
    recordEvent(db, { ...base, dedupeKey: 'container_down:radarr', title: 'radarr is down' });
    expect(listEvents(db, { unreadOnly: true, limit: 999 })).toHaveLength(3);
    markAllRead(db);
    expect(listEvents(db, { unreadOnly: true, limit: 999 })).toHaveLength(0);
  });

  it('markAllRead is a no-op when there are no unread events', () => {
    const id = recordEvent(db, base);
    markRead(db, [id]);
    expect(() => markAllRead(db)).not.toThrow();
    expect(listEvents(db, { unreadOnly: true, limit: 999 })).toHaveLength(0);
  });
});

describe('pruneEvents', () => {
  it('deletes read events older than the cutoff', () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    // Insert two read events at t0
    const id1 = recordEvent(db, base);
    const id2 = recordEvent(db, { ...base, dedupeKey: 'container_down:plex', title: 'plex is down' });
    markRead(db, [id1, id2]);
    // Advance 8 days
    vi.advanceTimersByTime(8 * 24 * 60 * 60 * 1000);
    const deleted = pruneEvents(db);
    expect(deleted).toBe(2);
    expect(listEvents(db, {})).toHaveLength(0);
  });

  it('does not delete read events within the cutoff', () => {
    vi.useFakeTimers();
    const id = recordEvent(db, base);
    markRead(db, [id]);
    // Only 3 days have passed — within default 7-day window
    vi.advanceTimersByTime(3 * 24 * 60 * 60 * 1000);
    const deleted = pruneEvents(db);
    expect(deleted).toBe(0);
    expect(listEvents(db, {})).toHaveLength(1);
  });

  it('does not delete unread events even when old', () => {
    vi.useFakeTimers();
    recordEvent(db, base); // unread
    vi.advanceTimersByTime(30 * 24 * 60 * 60 * 1000);
    const deleted = pruneEvents(db);
    expect(deleted).toBe(0);
    expect(listEvents(db, {})).toHaveLength(1);
  });

  it('accepts a custom olderThanMs cutoff', () => {
    vi.useFakeTimers();
    const id = recordEvent(db, base);
    markRead(db, [id]);
    vi.advanceTimersByTime(2 * 60 * 60 * 1000); // 2 hours
    // Prune with a 1-hour cutoff
    const deleted = pruneEvents(db, 60 * 60 * 1000);
    expect(deleted).toBe(1);
  });
});

describe('onceEver ledger survives pruneEvents and markAllRead', () => {
  it('does not re-fire after the event row is pruned', () => {
    vi.useFakeTimers();
    const avEvent: NormalizedEvent = {
      source: 'seerr', type: 'request_available', severity: 'info',
      title: 'Now available: Oppenheimer', dedupeKey: 'request_available:conn1:99',
      onceEver: true
    };
    const first = recordEvent(db, avEvent);
    expect(first).toBeGreaterThan(0);

    // Simulate user reading then pruning (delete the event row entirely)
    const id = listEvents(db, {})[0].id;
    markRead(db, [id]);
    // Advance 1ms so the event ts is strictly before the cutoff
    vi.advanceTimersByTime(1);
    const deleted = pruneEvents(db, 0);
    expect(deleted).toBe(1);
    expect(listEvents(db, {})).toHaveLength(0);

    // The ledger must still block re-insertion
    const second = recordEvent(db, avEvent);
    expect(second).toBe(0);
    expect(listEvents(db, {})).toHaveLength(0);
  });

  it('does not re-fire after markAllRead + pruneEvents wipes the events table', () => {
    vi.useFakeTimers();
    const avEvent: NormalizedEvent = {
      source: 'seerr', type: 'request_available', severity: 'info',
      title: 'Now available: Interstellar', dedupeKey: 'request_available:conn2:55',
      onceEver: true
    };
    recordEvent(db, avEvent);
    markAllRead(db);
    // Advance 1ms so the event ts is strictly before the cutoff
    vi.advanceTimersByTime(1);
    pruneEvents(db, 0);
    expect(listEvents(db, {})).toHaveLength(0);

    // Even long after, the same key must not re-insert
    vi.advanceTimersByTime(100 * 24 * 60 * 60 * 1000);
    const retry = recordEvent(db, avEvent);
    expect(retry).toBe(0);
    expect(listEvents(db, {})).toHaveLength(0);
  });

  it('non-onceEver event still re-fires after cooldown regardless of seen_events', () => {
    vi.useFakeTimers();
    const normalEv: NormalizedEvent = {
      source: 'docker', type: 'container_down', title: 'redis is down',
      body: 'exited', severity: 'crit', dedupeKey: 'container_down:redis',
      cooldownMs: 1000
    };
    recordEvent(db, normalEv);
    vi.advanceTimersByTime(2000);
    const again = recordEvent(db, normalEv);
    expect(again).toBeGreaterThan(0);
    expect(listEvents(db, {})).toHaveLength(2);
  });
});

describe('tickPoll overlap guard', () => {
  it('skips a tick while a previous run is still in flight', async () => {
    const docker = await import('../docker');
    const listContainers = docker.listContainers as ReturnType<typeof vi.fn>;
    listContainers.mockClear();

    // Start a slow run, then fire a second tick before the first resolves.
    const first = tickPoll(db);
    const second = tickPoll(db);   // should no-op because _running is still true
    await Promise.all([first, second]);

    // Only the first run reached the docker source; the overlapping tick was skipped.
    expect(listContainers).toHaveBeenCalledTimes(1);

    // After the run completes the guard resets and a later tick runs again.
    await tickPoll(db);
    expect(listContainers).toHaveBeenCalledTimes(2);
  });
});

describe('pollWatchlistAvailability', () => {
  beforeEach(() => {
    createConnection(db, { type: 'seerr', name: 'SE', baseUrl: 'http://se', secret: 'KEY', options: {} });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('notifies + flips on_server when a flagged title becomes available', async () => {
    addWatchlist(db, { consumerId: 5, tmdbId: 100, mediaType: 'tv', title: 'Spider-Noir', onServer: false, notifyOnAvailable: true });
    const spy = vi.spyOn(notify, 'notifyConsumer').mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ mediaInfo: { status: 5 } }), { status: 200 })));
    await pollWatchlistAvailability(db);
    expect(spy).toHaveBeenCalledWith(db, 5, expect.objectContaining({ title: expect.any(String) }));
    expect(listWatchlist(db, 5)[0].onServer).toBe(true);
    spy.mockClear();
    await pollWatchlistAvailability(db);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('does nothing while the title is still unavailable', async () => {
    addWatchlist(db, { consumerId: 5, tmdbId: 100, mediaType: 'tv', title: 'X', onServer: false, notifyOnAvailable: true });
    const spy = vi.spyOn(notify, 'notifyConsumer').mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ mediaInfo: { status: 2 } }), { status: 200 })));
    await pollWatchlistAvailability(db);
    expect(spy).not.toHaveBeenCalled();
    expect(listWatchlist(db, 5)[0].onServer).toBe(false);
    spy.mockRestore();
  });
});
