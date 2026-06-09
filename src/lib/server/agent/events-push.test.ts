// Ready-push wiring (D.3 Task 16) + ops-notify wiring (Task 9).
// Lives in a separate file from events.test.ts because that file globally mocks
// ../connections and ../../widgets, whereas this test needs the real
// listConnections + per-test spies on resolveWidget / notify functions.
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { createConnection } from '../connections';
import { createRole } from '../identity/roles';
import { createConsumer } from '../identity/consumers';
import { setSetting } from '../settings';
import * as widgetsP from '../../widgets';
import * as notifyP from '../notify';
import * as dockerP from '../docker';
import * as metricsP from '../metrics';
import { pollEvents } from './events';

let db: DB; let consumerId: number;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  createConnection(db, { type: 'seerr', name: 'SE', baseUrl: 'http://se', secret: 'K', options: {} });
  const r = createRole(db, { name: 'M', allowList: [], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} });
  consumerId = createConsumer(db, { roleId: r, displayName: 'Ana', language: 'en' });
  db.prepare(
    `insert into consumer_requests (consumer_id, seerr_request_id, tmdb_id, media_type, title, status, notified, created_at)
     values (?,?,?,?,?, 'processing', 0, ?)`
  ).run(consumerId, 555, 100, 'movie', 'Dune', Date.now());

  // Stub docker/metrics/widgets so only the source under test fires.
  vi.spyOn(dockerP, 'listContainers').mockResolvedValue({ available: false, containers: [] } as any);
  vi.spyOn(metricsP, 'collectStats').mockResolvedValue({ disks: [] } as any);
});
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------
// request_available → notifyConsumer
// ---------------------------------------------------------------------------
describe('ready-push via events', () => {
  it('flips the row to available and notifies exactly once', async () => {
    vi.spyOn(widgetsP, 'resolveWidget').mockResolvedValue({
      ok: true, data: [{ id: 555, title: 'Dune', status: 'Available' }]
    } as any);
    const sp = vi.spyOn(notifyP, 'notifyConsumer').mockResolvedValue();
    await pollEvents(db);
    await pollEvents(db); // second poll must NOT notify again (one-shot)
    const row = db.prepare('select status, notified from consumer_requests where seerr_request_id=555').get() as any;
    expect(row.status).toBe('available');
    expect(row.notified).toBe(1);
    expect(sp).toHaveBeenCalledTimes(1);
    expect(sp.mock.calls[0][1]).toBe(consumerId);
    expect(sp.mock.calls[0][2]).toMatchObject({ title: 'Ready to watch', url: '/app/requests' });
  });
});

// ---------------------------------------------------------------------------
// ops events → notifyAdmins
// ---------------------------------------------------------------------------
describe('ops notify via events', () => {
  it('calls notifyAdmins when container_down (crit) is newly recorded', async () => {
    vi.spyOn(widgetsP, 'resolveWidget').mockResolvedValue({ ok: false } as any);
    vi.spyOn(dockerP, 'listContainers').mockResolvedValue({
      available: true,
      containers: [{ id: 'jf', name: 'jellyfin', state: 'exited', status: 'Exited (1)' }]
    } as any);
    const sp = vi.spyOn(notifyP, 'notifyAdmins').mockResolvedValue();
    await pollEvents(db);
    expect(sp).toHaveBeenCalledTimes(1);
    expect(sp.mock.calls[0][1]).toMatchObject({ title: 'jellyfin is exited' });
  });

  it('does NOT call notifyAdmins a second time for the same container (deduped)', async () => {
    vi.spyOn(widgetsP, 'resolveWidget').mockResolvedValue({ ok: false } as any);
    vi.spyOn(dockerP, 'listContainers').mockResolvedValue({
      available: true,
      containers: [{ id: 'jf', name: 'jellyfin', state: 'exited', status: 'Exited (1)' }]
    } as any);
    const sp = vi.spyOn(notifyP, 'notifyAdmins').mockResolvedValue();
    await pollEvents(db);
    await pollEvents(db); // within cooldown — must be deduped
    expect(sp).toHaveBeenCalledTimes(1);
  });

  it('calls notifyAdmins for download_stalled (warn)', async () => {
    createConnection(db, { type: 'radarr', name: 'Rad', baseUrl: 'http://rad', secret: 'K', options: {} });
    vi.spyOn(widgetsP, 'resolveWidget').mockImplementation(async (_db, _connId, widget) => {
      if (widget === 'queue') return { ok: true, data: [{ id: 7, title: 'Dune Part Two', status: 'Stalled', progress: 0 }] } as any;
      return { ok: false } as any;
    });
    const sp = vi.spyOn(notifyP, 'notifyAdmins').mockResolvedValue();
    await pollEvents(db);
    expect(sp).toHaveBeenCalledTimes(1);
    expect(sp.mock.calls[0][1]).toMatchObject({ title: 'Download stalled: Dune Part Two' });
  });

  it('does NOT call notifyAdmins for disk_high at info severity', async () => {
    vi.spyOn(widgetsP, 'resolveWidget').mockResolvedValue({ ok: false } as any);
    vi.spyOn(metricsP, 'collectStats').mockResolvedValue({
      disks: [{ mount: '/', percent: 50 }]  // below DISK_THRESHOLD (80) → no event
    } as any);
    const sp = vi.spyOn(notifyP, 'notifyAdmins').mockResolvedValue();
    await pollEvents(db);
    expect(sp).not.toHaveBeenCalled();
  });

  it('does NOT call notifyAdmins for container_down when notify_prefs disables it', async () => {
    setSetting(db, 'notify_prefs', JSON.stringify({ container_down: false }));
    vi.spyOn(widgetsP, 'resolveWidget').mockResolvedValue({ ok: false } as any);
    vi.spyOn(dockerP, 'listContainers').mockResolvedValue({
      available: true,
      containers: [{ id: 'plex', name: 'plex', state: 'dead', status: 'dead' }]
    } as any);
    const sp = vi.spyOn(notifyP, 'notifyAdmins').mockResolvedValue();
    await pollEvents(db);
    expect(sp).not.toHaveBeenCalled();
  });

  it('calls notifyAdmins for disk_high (warn) when above threshold', async () => {
    vi.spyOn(widgetsP, 'resolveWidget').mockResolvedValue({ ok: false } as any);
    vi.spyOn(metricsP, 'collectStats').mockResolvedValue({
      disks: [{ mount: '/mnt/tank', percent: 85 }]  // 85 ≥ 80 → warn
    } as any);
    const sp = vi.spyOn(notifyP, 'notifyAdmins').mockResolvedValue();
    await pollEvents(db);
    expect(sp).toHaveBeenCalledTimes(1);
    expect(sp.mock.calls[0][1]).toMatchObject({ title: 'Disk /mnt/tank at 85%' });
  });
});
