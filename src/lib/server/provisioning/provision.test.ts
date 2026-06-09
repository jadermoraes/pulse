import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { createConnection } from '../connections';
import { createRole } from '../identity/roles';
import { createConsumer, getConsumer } from '../identity/consumers';
import { provisionConsumer, deprovisionConsumer, linkPlexAndWatchState, PlexAlreadyLinkedError, seerrPermissionsFor } from './provision';
import * as jf from './jellyfin';
import * as seerr from './seerr';
import * as plexAccount from './plex-account';
import * as watchstate from './watchstate';

let db: DB; let consumerId: number;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  createConnection(db, { type: 'jellyfin', name: 'JF', baseUrl: 'http://jf', secret: 'K', options: {} });
  createConnection(db, { type: 'seerr', name: 'Seerr', baseUrl: 'http://seerr', secret: 'S', options: {} });
  const roleId = createRole(db, {
    name: 'M', allowList: ['discover', 'request', 'status'],
    monthlyTokenCap: null, autoApprove: false, seerrQuota: { movie: 5 }
  });
  consumerId = createConsumer(db, { roleId, displayName: 'Ana', language: 'en' });
});
afterEach(() => vi.restoreAllMocks());

// seerr (this fork) Permission bits — verified live. ADMIN=2 must NEVER be set for a consumer.
const SEERR_ADMIN = 2;
const SEERR_REQUEST = 32;
const SEERR_AUTO_APPROVE = 128;

describe('seerrPermissionsFor — consumer gets REQUEST (32), NEVER ADMIN (2)', () => {
  it('a normal consumer (request, no auto-approve) → exactly REQUEST = 32', () => {
    const bits = seerrPermissionsFor({ allowList: ['discover', 'request', 'status'], autoApprove: false });
    expect(bits).toBe(SEERR_REQUEST);
    // The critical invariant: the ADMIN bit is never present.
    expect(bits & SEERR_ADMIN).toBe(0);
  });

  it('a consumer with auto-approve → REQUEST | AUTO_APPROVE = 160, still no ADMIN', () => {
    const bits = seerrPermissionsFor({ allowList: ['request'], autoApprove: true });
    expect(bits).toBe(SEERR_REQUEST | SEERR_AUTO_APPROVE); // 32 | 128 = 160
    expect(bits).toBe(160);
    expect(bits & SEERR_ADMIN).toBe(0);
  });

  it('a consumer WITHOUT request capability → 0, never ADMIN', () => {
    const bits = seerrPermissionsFor({ allowList: ['discover', 'status'], autoApprove: false });
    expect(bits).toBe(0);
    expect(bits & SEERR_ADMIN).toBe(0);
  });

  it('auto-approve without request still never yields ADMIN (no path sets bit 2)', () => {
    // Even a nonsensical combination must not flip the ADMIN bit.
    const bits = seerrPermissionsFor({ allowList: [], autoApprove: true });
    expect(bits & SEERR_ADMIN).toBe(0);
  });
});

describe('provisionConsumer', () => {
  it('runs jellyfin then seerr, stores ids, marks active', async () => {
    vi.spyOn(jf, 'ensureJellyfinUser').mockResolvedValue('jf-1');
    vi.spyOn(seerr, 'ensureSeerrUserFromJellyfin').mockResolvedValue(42);
    const consumer = getConsumer(db, consumerId)!;
    const out = await provisionConsumer(db, consumer, { username: 'ana', password: 'pw' });
    expect(out.jellyfinUserId).toBe('jf-1');
    expect(out.seerrUserId).toBe(42);
    const after = getConsumer(db, consumerId)!;
    expect(after.jellyfinUserId).toBe('jf-1');
    expect(after.seerrUserId).toBe(42);
    expect(after.status).toBe('active');
    // jellyfinUsername is persisted so post-reset auto-login can use the real login name.
    expect(after.jellyfinUsername).toBe('ana');
  });

  it('passes the role seerr quota + derived permissions to seerr', async () => {
    vi.spyOn(jf, 'ensureJellyfinUser').mockResolvedValue('jf-1');
    const seerrSpy = vi.spyOn(seerr, 'ensureSeerrUserFromJellyfin').mockResolvedValue(42);
    const consumer = getConsumer(db, consumerId)!;
    await provisionConsumer(db, consumer, { username: 'ana', password: 'pw' });
    expect(seerrSpy).toHaveBeenCalledWith(expect.anything(), 'jf-1', expect.any(Number), { movie: 5 });
  });

  it('rolls back the created Jellyfin user when the seerr step fails', async () => {
    vi.spyOn(jf, 'ensureJellyfinUser').mockResolvedValue('jf-1');
    const del = vi.spyOn(jf, 'deleteJellyfinUser').mockResolvedValue();
    vi.spyOn(seerr, 'ensureSeerrUserFromJellyfin').mockRejectedValue(new Error('seerr down'));
    const consumer = getConsumer(db, consumerId)!;
    await expect(provisionConsumer(db, consumer, { username: 'ana', password: 'pw' }))
      .rejects.toThrow(/seerr down/);
    expect(del).toHaveBeenCalledWith(expect.anything(), 'jf-1');
    const after = getConsumer(db, consumerId)!;
    expect(after.status).toBe('pending');     // not activated
    expect(after.seerrUserId).toBeNull();
  });

  it('is idempotent: a second run with the same creds does not throw', async () => {
    vi.spyOn(jf, 'ensureJellyfinUser').mockResolvedValue('jf-1');
    vi.spyOn(seerr, 'ensureSeerrUserFromJellyfin').mockResolvedValue(42);
    const consumer = getConsumer(db, consumerId)!;
    await provisionConsumer(db, consumer, { username: 'ana', password: 'pw' });
    const again = getConsumer(db, consumerId)!;
    await expect(provisionConsumer(db, again, { username: 'ana', password: 'pw' })).resolves.toBeTruthy();
  });

  it('throws a precise error when no Jellyfin connection exists', async () => {
    db.prepare("delete from connections where type='jellyfin'").run();
    const consumer = getConsumer(db, consumerId)!;
    await expect(provisionConsumer(db, consumer, { username: 'ana', password: 'pw' }))
      .rejects.toThrow(/jellyfin/i);
  });
});

describe('provisionConsumer — B.2 Plex/WatchState (optional, best-effort)', () => {
  function jfSeerrOk() {
    vi.spyOn(jf, 'ensureJellyfinUser').mockResolvedValue('jf-1');
    vi.spyOn(seerr, 'ensureSeerrUserFromJellyfin').mockResolvedValue(42);
  }

  it('without a plexToken: neither Plex nor WatchState runs (B.1 path unchanged)', async () => {
    jfSeerrOk();
    const acctSpy = vi.spyOn(plexAccount, 'plexAccountFromToken');
    const wsSpy = vi.spyOn(watchstate, 'mapWatchStateUser');
    const consumer = getConsumer(db, consumerId)!;
    const out = await provisionConsumer(db, consumer, { username: 'ana', password: 'pw' });
    expect(acctSpy).not.toHaveBeenCalled();
    expect(wsSpy).not.toHaveBeenCalled();
    expect(out.warning).toBeUndefined();
    expect(getConsumer(db, consumerId)!.plexAccountId).toBeNull();
  });

  it('with a plexToken + a watchstate connection: stores plexAccountId and maps WatchState', async () => {
    jfSeerrOk();
    createConnection(db, { type: 'watchstate', name: 'WS', baseUrl: 'http://ws', secret: 'W', options: {} });
    vi.spyOn(plexAccount, 'plexAccountFromToken').mockResolvedValue({ id: 'px-9', email: 'a@x' });
    const wsSpy = vi.spyOn(watchstate, 'mapWatchStateUser').mockResolvedValue();
    const consumer = getConsumer(db, consumerId)!;
    const out = await provisionConsumer(db, consumer, { username: 'ana', password: 'pw', plexToken: 't' });
    expect(out.warning).toBeUndefined();
    expect(wsSpy).toHaveBeenCalledWith(expect.anything(),
      { jellyfinUserId: 'jf-1', plexAccountId: 'px-9', displayName: 'Ana' });
    expect(getConsumer(db, consumerId)!.plexAccountId).toBe('px-9');
  });

  it('with a plexToken but NO watchstate connection: stores plexAccountId, no WS call, no warning', async () => {
    jfSeerrOk();
    vi.spyOn(plexAccount, 'plexAccountFromToken').mockResolvedValue({ id: 'px-9', email: 'a@x' });
    const wsSpy = vi.spyOn(watchstate, 'mapWatchStateUser').mockResolvedValue();
    const consumer = getConsumer(db, consumerId)!;
    const out = await provisionConsumer(db, consumer, { username: 'ana', password: 'pw', plexToken: 't' });
    expect(wsSpy).not.toHaveBeenCalled();
    expect(out.warning).toBeUndefined();
    expect(getConsumer(db, consumerId)!.plexAccountId).toBe('px-9');
  });

  it('graceful degradation: Plex fails → Jellyfin+seerr stay provisioned, consumer ACTIVE, warning surfaced', async () => {
    jfSeerrOk();
    vi.spyOn(plexAccount, 'plexAccountFromToken').mockRejectedValue(new Error('plex down'));
    const consumer = getConsumer(db, consumerId)!;
    const out = await provisionConsumer(db, consumer, { username: 'ana', password: 'pw', plexToken: 't' });
    // Core provisioning is intact:
    expect(out.jellyfinUserId).toBe('jf-1');
    expect(out.seerrUserId).toBe(42);
    expect(out.warning).toMatch(/plex/i);
    const after = getConsumer(db, consumerId)!;
    expect(after.jellyfinUserId).toBe('jf-1');
    expect(after.seerrUserId).toBe(42);
    expect(after.status).toBe('active'); // NOT rolled back
    expect(after.plexAccountId).toBeNull(); // Plex never resolved
  });

  it('graceful degradation: WatchState map fails → consumer stays active + plexAccountId stored + warning', async () => {
    jfSeerrOk();
    createConnection(db, { type: 'watchstate', name: 'WS', baseUrl: 'http://ws', secret: 'W', options: {} });
    vi.spyOn(plexAccount, 'plexAccountFromToken').mockResolvedValue({ id: 'px-9', email: 'a@x' });
    vi.spyOn(watchstate, 'mapWatchStateUser').mockRejectedValue(new Error('ws 500'));
    const consumer = getConsumer(db, consumerId)!;
    const out = await provisionConsumer(db, consumer, { username: 'ana', password: 'pw', plexToken: 't' });
    expect(out.warning).toMatch(/watchstate|ws 500/i);
    const after = getConsumer(db, consumerId)!;
    expect(after.status).toBe('active');
    expect(after.plexAccountId).toBe('px-9'); // stored before the WS step failed
  });
});

describe('provisionConsumer — Plex library share (FIX 3, best-effort)', () => {
  function jfSeerrOk() {
    vi.spyOn(jf, 'ensureJellyfinUser').mockResolvedValue('jf-1');
    vi.spyOn(seerr, 'ensureSeerrUserFromJellyfin').mockResolvedValue(42);
  }
  // Stub plex.tv/owner HTTP: /identity → machineId, /library/sections → two sections,
  // and capture the v1 shared_servers POST.
  function stubPlexHttp(opts: { shareStatus?: number } = {}) {
    const captured: { url?: string; body?: any; token?: string } = {};
    vi.stubGlobal('fetch', vi.fn(async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/identity'))
        return new Response(JSON.stringify({ MediaContainer: { machineIdentifier: 'machine-xyz' } }), { status: 200 });
      if (url.includes('/library/sections'))
        return new Response(JSON.stringify({ MediaContainer: { Directory: [{ key: '1' }, { key: '2' }] } }), { status: 200 });
      if (url.includes('/shared_servers')) {
        captured.url = url;
        captured.token = (init?.headers as any)?.['X-Plex-Token'];
        captured.body = JSON.parse(String(init?.body));
        return new Response('{}', { status: opts.shareStatus ?? 200 });
      }
      return new Response('unmatched', { status: 500 });
    }));
    return captured;
  }

  it('shares ALL sections via the v1 endpoint when a plex connection exists', async () => {
    jfSeerrOk();
    createConnection(db, { type: 'plex', name: 'Plex', baseUrl: 'http://plex:32400', secret: 'OWNER', options: {} });
    vi.spyOn(plexAccount, 'plexAccountFromToken').mockResolvedValue({ id: 'px-9', email: 'ana@x' });
    const captured = stubPlexHttp();
    const consumer = getConsumer(db, consumerId)!;
    const out = await provisionConsumer(db, consumer, { username: 'ana', password: 'pw', plexToken: 't' });
    expect(out.warning).toBeUndefined();
    expect(captured.url).toContain('/api/servers/machine-xyz/shared_servers');
    expect(captured.token).toBe('OWNER');
    expect(captured.body.server_id).toBe('machine-xyz');
    expect(captured.body.shared_server.invited_email).toBe('ana@x');
    expect(captured.body.shared_server.library_section_ids).toEqual([1, 2]);
    expect(getConsumer(db, consumerId)!.plexAccountId).toBe('px-9');
  });

  it('degrades to a warning when the share POST fails (account still linked, active)', async () => {
    jfSeerrOk();
    createConnection(db, { type: 'plex', name: 'Plex', baseUrl: 'http://plex:32400', secret: 'OWNER', options: {} });
    vi.spyOn(plexAccount, 'plexAccountFromToken').mockResolvedValue({ id: 'px-9', email: 'ana@x' });
    stubPlexHttp({ shareStatus: 500 });
    const consumer = getConsumer(db, consumerId)!;
    const out = await provisionConsumer(db, consumer, { username: 'ana', password: 'pw', plexToken: 't' });
    expect(out.warning).toMatch(/plex library share/i);
    const after = getConsumer(db, consumerId)!;
    expect(after.status).toBe('active');
    expect(after.plexAccountId).toBe('px-9'); // account linked despite share failure
  });

  it('skips the share cleanly when NO plex connection is configured', async () => {
    jfSeerrOk();
    vi.spyOn(plexAccount, 'plexAccountFromToken').mockResolvedValue({ id: 'px-9', email: 'ana@x' });
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const consumer = getConsumer(db, consumerId)!;
    const out = await provisionConsumer(db, consumer, { username: 'ana', password: 'pw', plexToken: 't' });
    expect(out.warning).toBeUndefined();
    // No plex/identity/sections/shared_servers HTTP at all.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(getConsumer(db, consumerId)!.plexAccountId).toBe('px-9');
  });
});

describe('1:1 Plex uniqueness (B.2 review finding)', () => {
  let roleId: number;
  beforeEach(() => {
    roleId = createRole(db, {
      name: 'UniqRole', allowList: ['discover'], monthlyTokenCap: null, autoApprove: false, seerrQuota: {}
    });
  });

  it('linkPlexAndWatchState throws PlexAlreadyLinkedError when plexAccountId already claimed', async () => {
    // Consumer A links plex account px-99.
    const idA = createConsumer(db, { roleId, displayName: 'ConsA', language: 'en' });
    const consA = getConsumer(db, idA)!;
    vi.spyOn(plexAccount, 'plexAccountFromToken').mockResolvedValue({ id: 'px-99', email: 'a@x' });
    await linkPlexAndWatchState(db, consA, 'tok-a', null);
    expect(getConsumer(db, idA)!.plexAccountId).toBe('px-99');

    // Consumer B tries to link the same plex account → PlexAlreadyLinkedError.
    const idB = createConsumer(db, { roleId, displayName: 'ConsB', language: 'en' });
    const consB = getConsumer(db, idB)!;
    vi.spyOn(plexAccount, 'plexAccountFromToken').mockResolvedValue({ id: 'px-99', email: 'a@x' });
    await expect(linkPlexAndWatchState(db, consB, 'tok-b', null))
      .rejects.toBeInstanceOf(PlexAlreadyLinkedError);

    // Consumer A's record is untouched.
    expect(getConsumer(db, idA)!.plexAccountId).toBe('px-99');
    // Consumer B has no plexAccountId.
    expect(getConsumer(db, idB)!.plexAccountId).toBeNull();
  });

  it('multiple consumers WITHOUT a plexAccountId are allowed (NULLs are not unique)', () => {
    // Both consumers have plexAccountId = NULL — this must NOT violate the unique index.
    const idA = createConsumer(db, { roleId, displayName: 'NullA', language: 'en' });
    const idB = createConsumer(db, { roleId, displayName: 'NullB', language: 'en' });
    expect(getConsumer(db, idA)!.plexAccountId).toBeNull();
    expect(getConsumer(db, idB)!.plexAccountId).toBeNull();
    // No exception thrown — both rows co-exist fine.
  });

  it('onboarding with a duplicate plexToken degrades to a warning, never 502', async () => {
    // First consumer links px-dup during provisioning (fake mode).
    vi.spyOn(jf, 'ensureJellyfinUser').mockResolvedValue('jf-a');
    vi.spyOn(seerr, 'ensureSeerrUserFromJellyfin').mockResolvedValue(1);
    vi.spyOn(plexAccount, 'plexAccountFromToken').mockResolvedValue({ id: 'px-dup', email: 'a@x' });
    const consA = getConsumer(db, consumerId)!;
    const outA = await provisionConsumer(db, consA, { username: 'ana', password: 'pw', plexToken: 'tok-dup' });
    expect(outA.warning).toBeUndefined();
    expect(getConsumer(db, consumerId)!.plexAccountId).toBe('px-dup');

    // Second consumer tries to provision with the same Plex token.
    const roleId2 = createRole(db, {
      name: 'M2', allowList: ['discover'], monthlyTokenCap: null, autoApprove: false, seerrQuota: {}
    });
    const idB = createConsumer(db, { roleId: roleId2, displayName: 'Bob', language: 'en' });
    vi.spyOn(jf, 'ensureJellyfinUser').mockResolvedValue('jf-b');
    vi.spyOn(seerr, 'ensureSeerrUserFromJellyfin').mockResolvedValue(2);
    vi.spyOn(plexAccount, 'plexAccountFromToken').mockResolvedValue({ id: 'px-dup', email: 'a@x' });
    const consB = getConsumer(db, idB)!;
    // Must NOT throw — degrades to a warning instead.
    const outB = await provisionConsumer(db, consB, { username: 'bob', password: 'pw', plexToken: 'tok-dup' });
    expect(outB.jellyfinUserId).toBe('jf-b');   // core is fine
    expect(outB.seerrUserId).toBe(2);            // core is fine
    expect(outB.warning).toMatch(/already linked|unique|plex/i); // warning surfaced
    // Consumer A untouched.
    expect(getConsumer(db, consumerId)!.plexAccountId).toBe('px-dup');
    // Consumer B has no plexAccountId (the link was rejected).
    expect(getConsumer(db, idB)!.plexAccountId).toBeNull();
  });
});

describe('deprovisionConsumer', () => {
  it('calls deleteJellyfinUser + deleteSeerrUser with the stored ids', async () => {
    const jfDel = vi.spyOn(jf, 'deleteJellyfinUser').mockResolvedValue();
    const seerrDel = vi.spyOn(seerr, 'deleteSeerrUser').mockResolvedValue();
    // Manually give the consumer downstream ids.
    const { updateConsumer } = await import('../identity/consumers');
    updateConsumer(db, consumerId, { jellyfinUserId: 'jf-ana', seerrUserId: 77 });
    const consumer = getConsumer(db, consumerId)!;
    const result = await deprovisionConsumer(db, consumer);
    expect(jfDel).toHaveBeenCalledWith(expect.objectContaining({ type: 'jellyfin' }), 'jf-ana');
    expect(seerrDel).toHaveBeenCalledWith(expect.objectContaining({ type: 'seerr' }), 77);
    expect(result.warnings).toEqual([]);
  });

  it('still removes the Pulse record context and returns a warning when Jellyfin delete throws', async () => {
    vi.spyOn(jf, 'deleteJellyfinUser').mockRejectedValue(new Error('jf 500'));
    vi.spyOn(seerr, 'deleteSeerrUser').mockResolvedValue();
    const { updateConsumer } = await import('../identity/consumers');
    updateConsumer(db, consumerId, { jellyfinUserId: 'jf-ana', seerrUserId: 77 });
    const consumer = getConsumer(db, consumerId)!;
    const result = await deprovisionConsumer(db, consumer);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/jellyfin/i);
    // seerr delete still ran (independent try/catch)
    expect(vi.mocked(seerr.deleteSeerrUser)).toHaveBeenCalled();
  });

  it('still removes context and returns a warning when seerr delete throws', async () => {
    vi.spyOn(jf, 'deleteJellyfinUser').mockResolvedValue();
    vi.spyOn(seerr, 'deleteSeerrUser').mockRejectedValue(new Error('seerr 503'));
    const { updateConsumer } = await import('../identity/consumers');
    updateConsumer(db, consumerId, { jellyfinUserId: 'jf-ana', seerrUserId: 77 });
    const consumer = getConsumer(db, consumerId)!;
    const result = await deprovisionConsumer(db, consumer);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/seerr/i);
    // Jellyfin delete still ran
    expect(vi.mocked(jf.deleteJellyfinUser)).toHaveBeenCalled();
  });

  it('skips provider calls and returns no warnings when consumer has no downstream ids', async () => {
    const jfDel = vi.spyOn(jf, 'deleteJellyfinUser').mockResolvedValue();
    const seerrDel = vi.spyOn(seerr, 'deleteSeerrUser').mockResolvedValue();
    const consumer = getConsumer(db, consumerId)!; // jellyfinUserId=null, seerrUserId=null by default
    const result = await deprovisionConsumer(db, consumer);
    expect(jfDel).not.toHaveBeenCalled();
    expect(seerrDel).not.toHaveBeenCalled();
    expect(result.warnings).toEqual([]);
  });
});
