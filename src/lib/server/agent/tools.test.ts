import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { createConnection } from '../connections';
import { registerIntegration } from '../integrations/registry';
import type { Integration } from '../integrations/types';
import * as http from '../http';
import * as passthrough from './api-passthrough';
import * as docker from '../docker';
import { buildToolSpecs, toAiTools } from './tools';
import type { AgentContext } from './types';

// A minimal integration with one read widget + one write action.
const stub: Integration = {
  type: 'stubsvc', label: 'Stub', icon: 'x', configSchema: [],
  async testConnection() { return { ok: true, message: 'ok' }; },
  widgets: {
    queue: async () => ({ ok: true, data: [{ id: 1, title: 'X' }] }),
    huge: async () => ({
      ok: true,
      data: Array.from({ length: 1000 }, (_, i) => ({ id: i, pad: 'x'.repeat(300) }))
    })
  },
  actions: {
    approve: { id: 'approve', label: 'Approve', kind: 'request',
      async run(conn, params) { return { ok: true, message: `approved ${params.id}` }; } },
    request: { id: 'request', label: 'Request', kind: 'request',
      async run(conn, params) { return { ok: true, message: 'Requested', echoed: params }; } }
  }
};
registerIntegration(stub);

let db: DB; let ctx: AgentContext;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  ctx = { db, user: { id: 1, email: 'a@b.com' }, channel: 'web', conversationId: 1 };
});
afterEach(() => vi.restoreAllMocks());

describe('buildToolSpecs', () => {
  it('always includes the listConnections + getEvents read tools', async () => {
    const specs = await buildToolSpecs(ctx);
    const names = specs.map((s) => s.name);
    expect(names).toContain('listConnections');
    expect(names).toContain('getEvents');
    expect(names).toContain('getServerStats');
    expect(specs.find((s) => s.name === 'listConnections')!.risk).toBe('read');
  });

  it('emits a getWidget read tool and a runAction write tool when a connection exists', async () => {
    createConnection(db, { type: 'stubsvc', name: 'S', baseUrl: 'http://x', secret: 'KEY', options: {} });
    const specs = await buildToolSpecs(ctx);
    const getWidget = specs.find((s) => s.name === 'getWidget')!;
    const runAction = specs.find((s) => s.name === 'runAction')!;
    expect(getWidget.risk).toBe('read');
    expect(runAction.risk).toBe('write');
  });

  it('getWidget runs resolveWidget and returns scrubbed data (no secret leaks)', async () => {
    const id = createConnection(db, { type: 'stubsvc', name: 'S', baseUrl: 'http://x', secret: 'KEY', options: {} });
    const specs = await buildToolSpecs(ctx);
    const getWidget = specs.find((s) => s.name === 'getWidget')!;
    const out = await getWidget.run(ctx, { connectionId: id, widget: 'queue' });
    expect(JSON.stringify(out)).not.toContain('KEY');
    expect(JSON.stringify(out)).toContain('"title":"X"');
  });

  it('admin runAction request sends NO userId (owner attribution)', async () => {
    const id = createConnection(db, { type: 'stubsvc', name: 'S', baseUrl: 'http://x', secret: 'KEY', options: {} });
    const specs = await buildToolSpecs(ctx);
    const runAction = specs.find((s) => s.name === 'runAction')!;
    const out: any = await runAction.run(ctx, { connectionId: id, action: 'request', params: { mediaType: 'movie', tmdbId: 550 } });
    expect(out).toMatchObject({ ok: true });
    expect(out.echoed.userId).toBeUndefined();
  });

  it('consumer runAction request injects the consumer seerrUserId', async () => {
    const { createRole } = await import('../identity/roles');
    const { createConsumer, updateConsumer } = await import('../identity/consumers');
    const roleId = createRole(db, { name: 'Member', allowList: ['request'], monthlyTokenCap: 1000, autoApprove: true, seerrQuota: {} });
    const consumerId = createConsumer(db, { roleId, displayName: 'Ana', language: 'en' });
    updateConsumer(db, consumerId, { seerrUserId: 42 });
    const cctx = { ...ctx, consumer: { id: consumerId, roleId } };
    const id = createConnection(db, { type: 'stubsvc', name: 'S', baseUrl: 'http://x', secret: 'KEY', options: {} });
    const specs = await buildToolSpecs(cctx);
    const runAction = specs.find((s) => s.name === 'runAction')!;
    const out: any = await runAction.run(cctx, { connectionId: id, action: 'request', params: { mediaType: 'movie', tmdbId: 550 } });
    expect(out.echoed.userId).toBe(42);
  });

  it('runAction.run dispatches resolveAction and summarize/undo are present', async () => {
    const id = createConnection(db, { type: 'stubsvc', name: 'S', baseUrl: 'http://x', secret: 'KEY', options: {} });
    const specs = await buildToolSpecs(ctx);
    const runAction = specs.find((s) => s.name === 'runAction')!;
    const out: any = await runAction.run(ctx, { connectionId: id, action: 'approve', params: { id: 7 } });
    expect(out).toMatchObject({ ok: true });
    expect(typeof runAction.summarize).toBe('function');
    expect(runAction.summarize!(ctx, { connectionId: id, action: 'approve', params: { id: 7 } })).toContain('approve');
  });

  it('searchMedia is a read tool that returns normalized {title,year,tmdbId,mediaType} from seerr search', async () => {
    createConnection(db, { type: 'seerr', name: 'SE', baseUrl: 'http://se', secret: 'KEY', options: {} });
    vi.spyOn(http, 'getJsonWithKey').mockResolvedValue({
      results: [
        { id: 1234, mediaType: 'movie', title: 'Heavy Trip', releaseDate: '2018-03-09', overview: 'Metal band.' },
        { id: 200, mediaType: 'tv', name: 'Severance', firstAirDate: '2022-02-18' },
        { id: 999, mediaType: 'person', name: 'Some Actor' }
      ]
    } as any);
    const specs = await buildToolSpecs(ctx);
    const searchMedia = specs.find((s) => s.name === 'searchMedia')!;
    expect(searchMedia.risk).toBe('read');
    const out: any = await searchMedia.run(ctx, { query: 'Heavy Trip' });
    // person is filtered out, only movie+tv remain
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toMatchObject({ title: 'Heavy Trip', year: 2018, tmdbId: 1234, mediaType: 'movie' });
    expect(out.results[1]).toMatchObject({ title: 'Severance', year: 2022, tmdbId: 200, mediaType: 'tv' });
    expect(JSON.stringify(out)).not.toContain('KEY');
  });

  it('searchMedia percent-encodes the query (uses %20, not + for a multi-word search)', async () => {
    createConnection(db, { type: 'seerr', name: 'SE', baseUrl: 'http://se', secret: 'KEY', options: {} });
    let capturedUrl = '';
    vi.spyOn(http, 'getJsonWithKey').mockImplementation(async (url: string) => {
      capturedUrl = url;
      return { results: [] } as any;
    });
    const specs = await buildToolSpecs(ctx);
    const searchMedia = specs.find((s) => s.name === 'searchMedia')!;
    await searchMedia.run(ctx, { query: 'heavy trip' });
    expect(capturedUrl).toContain('query=heavy%20trip');
    expect(capturedUrl).not.toContain('heavy+trip');
  });

  it('searchMedia with no seerr connection returns an empty list with an error', async () => {
    const specs = await buildToolSpecs(ctx);
    const searchMedia = specs.find((s) => s.name === 'searchMedia')!;
    const out: any = await searchMedia.run(ctx, { query: 'Heavy Trip' });
    expect(out.results).toEqual([]);
    expect(out.error).toBeTruthy();
  });

  it('exposes apiRead/apiWrite to admin, not consumer', async () => {
    const admin = await buildToolSpecs({ db, user: { id: 1, email: '' }, channel: 'web', conversationId: 1 } as any);
    expect(admin.find((s) => s.name === 'apiRead')).toBeTruthy();
    expect(admin.find((s) => s.name === 'apiRead')?.risk).toBe('read');
    expect(admin.find((s) => s.name === 'apiWrite')?.risk).toBe('write');
    const consumer = await buildToolSpecs({ db, consumer: { id: 1, roleId: 1 }, channel: 'web', conversationId: 1 } as any);
    expect(consumer.find((s) => s.name === 'apiRead')).toBeUndefined();
    expect(consumer.find((s) => s.name === 'apiWrite')).toBeUndefined();
  });

  it('apiRead dispatches to connectionApiRequest', async () => {
    const radarrId = createConnection(db, { type: 'radarr', name: 'R', baseUrl: 'http://r', secret: 'KEY', options: {} });
    vi.spyOn(passthrough, 'connectionApiRequest').mockResolvedValue({ status: 200, data: { ok: 1 } });
    const specs = await buildToolSpecs({ db, user: { id: 1, email: '' }, channel: 'web', conversationId: 1 } as any);
    const apiRead = specs.find((s) => s.name === 'apiRead')!;
    const out: any = await apiRead.run({ db } as any, { connectionId: radarrId, path: '/api/v3/movie' });
    expect(passthrough.connectionApiRequest).toHaveBeenCalled();
    expect(out).toMatchObject({ status: 200 });
    expect(JSON.stringify(out)).not.toContain('KEY');
  });

  it('apiWrite rejects GET and only runs after confirm (write risk, summarize present)', async () => {
    const radarrId = createConnection(db, { type: 'radarr', name: 'R', baseUrl: 'http://r', secret: 'KEY', options: {} });
    vi.spyOn(passthrough, 'connectionApiRequest').mockResolvedValue({ status: 201, data: { id: 9 } });
    const specs = await buildToolSpecs({ db, user: { id: 1, email: '' }, channel: 'web', conversationId: 1 } as any);
    const apiWrite = specs.find((s) => s.name === 'apiWrite')!;
    const bad: any = await apiWrite.run({ db } as any, { connectionId: radarrId, method: 'GET', path: '/api/v3/movie' });
    expect(bad.status).toBe(0);
    expect(bad.data.error).toContain('POST/PUT/PATCH/DELETE');
    const out: any = await apiWrite.run({ db } as any, { connectionId: radarrId, method: 'POST', path: '/api/v3/movie', body: { tmdbId: 1 }, summary: 'Add Heat to Radarr' });
    expect(out).toMatchObject({ status: 201 });
    expect(typeof apiWrite.summarize).toBe('function');
    expect(apiWrite.summarize!({ db } as any, { connectionId: radarrId, method: 'POST', path: '/api/v3/movie', summary: 'Add Heat to Radarr' })).toBe('Add Heat to Radarr');
  });

  it('scrubs token-like fields (nested) from a connectionApiRequest result before it reaches the LLM', async () => {
    const radarrId = createConnection(db, { type: 'radarr', name: 'R', baseUrl: 'http://r', secret: 'KEY', options: {} });
    // The upstream API leaks secrets in its response body, including NESTED ones.
    vi.spyOn(passthrough, 'connectionApiRequest').mockResolvedValue({
      status: 200,
      data: { token: 'leaky-secret-value', nested: { apiKey: 'also-leaky' } }
    });
    const specs = await buildToolSpecs({ db, user: { id: 1, email: '' }, channel: 'web', conversationId: 1 } as any);
    // Both apiRead and apiWrite must scrub the passthrough result.
    const apiRead = specs.find((s) => s.name === 'apiRead')!;
    const apiWrite = specs.find((s) => s.name === 'apiWrite')!;
    const readOut: any = await apiRead.run({ db } as any, { connectionId: radarrId, path: '/api/v3/system/status' });
    const writeOut: any = await apiWrite.run({ db } as any, { connectionId: radarrId, method: 'POST', path: '/api/v3/movie', body: { tmdbId: 1 }, summary: 'Add' });
    for (const out of [readOut, writeOut]) {
      const s = JSON.stringify(out);
      // The secret VALUES never reach the model...
      expect(s).not.toContain('leaky-secret-value');
      expect(s).not.toContain('also-leaky');
      // ...and the token-like keys (top-level + nested) are redacted.
      expect(out.data.token).toBe('[redacted]');
      expect(out.data.nested.apiKey).toBe('[redacted]');
      expect(out.status).toBe(200);
    }
  });

  it('exposes dockerApi/dockerWrite to admin, not consumer', async () => {
    const admin = await buildToolSpecs({ db, user: { id: 1, email: '' }, channel: 'web', conversationId: 1 } as any);
    expect(admin.find((s) => s.name === 'dockerApi')?.risk).toBe('read');
    expect(admin.find((s) => s.name === 'dockerWrite')?.risk).toBe('write');
    const consumer = await buildToolSpecs({ db, consumer: { id: 1, roleId: 1 }, channel: 'web', conversationId: 1 } as any);
    expect(consumer.find((s) => s.name === 'dockerApi')).toBeUndefined();
    expect(consumer.find((s) => s.name === 'dockerWrite')).toBeUndefined();
  });

  it('dockerApi GETs via dockerRequest and appends the query string', async () => {
    vi.spyOn(docker, 'dockerRequest').mockResolvedValue({ status: 200, data: [{ Id: 'x' }] });
    const specs = await buildToolSpecs({ db, user: { id: 1, email: '' }, channel: 'web', conversationId: 1 } as any);
    const dockerApi = specs.find((s) => s.name === 'dockerApi')!;
    const out: any = await dockerApi.run({ db } as any, { path: '/containers/json', query: { all: 1 } });
    expect(docker.dockerRequest).toHaveBeenCalledWith('GET', '/containers/json?all=1');
    expect(out).toMatchObject({ status: 200 });
  });

  it('dockerWrite POSTs via dockerRequest and has a summarize', async () => {
    vi.spyOn(docker, 'dockerRequest').mockResolvedValue({ status: 204, data: {} });
    const specs = await buildToolSpecs({ db, user: { id: 1, email: '' }, channel: 'web', conversationId: 1 } as any);
    const dockerWrite = specs.find((s) => s.name === 'dockerWrite')!;
    const out: any = await dockerWrite.run({ db } as any, { method: 'POST', path: '/containers/abc/start', summary: 'Start abc' });
    expect(docker.dockerRequest).toHaveBeenCalledWith('POST', '/containers/abc/start', undefined);
    expect(out).toMatchObject({ status: 204 });
    expect(typeof dockerWrite.summarize).toBe('function');
    expect(dockerWrite.summarize!({ db } as any, { method: 'POST', path: '/containers/abc/start', summary: 'Start abc' })).toBe('Start abc');
  });

  it('dockerWrite rejects non-write methods (GET) and never calls dockerRequest', async () => {
    const spy = vi.spyOn(docker, 'dockerRequest').mockResolvedValue({ status: 200, data: {} });
    const specs = await buildToolSpecs({ db, user: { id: 1, email: '' }, channel: 'web', conversationId: 1 } as any);
    const dockerWrite = specs.find((s) => s.name === 'dockerWrite')!;
    const bad: any = await dockerWrite.run({ db } as any, { method: 'GET', path: '/containers/json', summary: 'x' });
    expect(bad.status).toBe(0);
    expect(bad.data.error).toContain('POST/PUT/DELETE');
    expect(spy).not.toHaveBeenCalled();
  });

  it('dockerWrite rejects a path containing /exec (no container shell)', async () => {
    const spy = vi.spyOn(docker, 'dockerRequest').mockResolvedValue({ status: 200, data: {} });
    const specs = await buildToolSpecs({ db, user: { id: 1, email: '' }, channel: 'web', conversationId: 1 } as any);
    const dockerWrite = specs.find((s) => s.name === 'dockerWrite')!;
    const bad: any = await dockerWrite.run({ db } as any, { method: 'POST', path: '/containers/abc/exec', summary: 'shell' });
    expect(bad.status).toBe(0);
    expect(bad.data.error).toMatch(/exec/i);
    expect(spy).not.toHaveBeenCalled();
  });

  it('watchlist tools are consumer-only (absent on an admin turn)', async () => {
    const admin = await buildToolSpecs({ db, user: { id: 1, email: '' }, channel: 'web', conversationId: 1 } as any);
    expect(admin.find((s) => s.name === 'watchlistAdd')).toBeUndefined();
  });

  it('watchlistAdd persists a row + watchlistList returns it (consumer turn)', async () => {
    createConnection(db, { type: 'seerr', name: 'SE', baseUrl: 'http://se', secret: 'KEY', options: {} });
    vi.stubGlobal('fetch', vi.fn(async () =>
      new Response(JSON.stringify({ mediaInfo: { status: 1 } }), { status: 200 }))); // not on server
    const ctx = { db, consumer: { id: 5, roleId: 1 }, channel: 'web', conversationId: 1 } as any;
    const specs = await buildToolSpecs(ctx);
    const add = specs.find((s) => s.name === 'watchlistAdd')!;
    const list = specs.find((s) => s.name === 'watchlistList')!;
    await add.run(ctx, { tmdbId: 100, mediaType: 'tv', title: 'Spider-Noir' });
    const out: any = await list.run(ctx, {});
    expect(out.items).toHaveLength(1);
    expect(out.items[0]).toMatchObject({ tmdbId: 100, mediaType: 'tv', onServer: false, notifyOnAvailable: true });
    vi.unstubAllGlobals();
  });

  it('watchlistRemove deletes the row', async () => {
    const ctx = { db, consumer: { id: 6, roleId: 1 }, channel: 'web', conversationId: 1 } as any;
    const specs = await buildToolSpecs(ctx);
    const add = specs.find((s) => s.name === 'watchlistAdd')!;
    const remove = specs.find((s) => s.name === 'watchlistRemove')!;
    const list = specs.find((s) => s.name === 'watchlistList')!;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ mediaInfo: { status: 1 } }), { status: 200 })));
    await add.run(ctx, { tmdbId: 200, mediaType: 'movie', title: 'M' });
    vi.unstubAllGlobals();
    const r: any = await remove.run(ctx, { tmdbId: 200, mediaType: 'movie' });
    expect(r.ok).toBe(true);
    expect((await list.run(ctx, {}) as any).items).toHaveLength(0);
  });

  it('cancelRequest is consumer-only and refuses when the consumer has no seerr account', async () => {
    const { createRole } = await import('../identity/roles');
    const { createConsumer } = await import('../identity/consumers');
    const roleId = createRole(db, { name: 'M', allowList: ['request'], monthlyTokenCap: 1000, autoApprove: true, seerrQuota: {} });
    const cId = createConsumer(db, { roleId, displayName: 'Ana', language: 'en' });
    const ctx2 = { db, consumer: { id: cId, roleId }, channel: 'web', conversationId: 1 } as any;
    const specs = await buildToolSpecs(ctx2);
    expect(specs.find((s) => s.name === 'cancelRequest')).toBeTruthy();
    const out: any = await specs.find((s) => s.name === 'cancelRequest')!.run(ctx2, { requestId: 1 });
    expect(out.ok).toBe(false);
  });

  it('messageAdmin notifies admins and logs an access event', async () => {
    const notify = await import('../notify');
    const access = await import('../identity/access-log');
    const spyNotify = vi.spyOn(notify, 'notifyAdminsTracked').mockResolvedValue(undefined);
    const spyLog = vi.spyOn(access, 'logAccess').mockReturnValue(undefined as any);
    const { createRole } = await import('../identity/roles');
    const { createConsumer } = await import('../identity/consumers');
    const roleId = createRole(db, { name: 'M', allowList: ['message_admin'], monthlyTokenCap: 1000, autoApprove: true, seerrQuota: {} });
    const cId = createConsumer(db, { roleId, displayName: 'Ana', language: 'en' });
    const mctx = { db, consumer: { id: cId, roleId }, channel: 'web', conversationId: 1 } as any;
    const specs = await buildToolSpecs(mctx);
    const tool = specs.find((s) => s.name === 'messageAdmin')!;
    const out: any = await tool.run(mctx, { message: 'Stranger Things won\'t play' });
    expect(out.ok).toBe(true);
    expect(spyNotify).toHaveBeenCalledWith(db, expect.objectContaining({ title: 'Message from Ana', body: 'Stranger Things won\'t play', url: '/messages' }), expect.any(Number));
    expect(spyLog).toHaveBeenCalledWith(db, expect.objectContaining({ consumerId: cId, type: 'message_admin' }));
    vi.restoreAllMocks();
  });

  it('messageAdmin persists the message row', async () => {
    const notify = await import('../notify');
    vi.spyOn(notify, 'notifyAdminsTracked').mockResolvedValue(undefined);
    const { createRole } = await import('../identity/roles');
    const { createConsumer } = await import('../identity/consumers');
    const { listMessages } = await import('../consumer/messages');
    const roleId = createRole(db, { name: 'M3', allowList: ['message_admin'], monthlyTokenCap: 1000, autoApprove: true, seerrQuota: {} });
    const cId = createConsumer(db, { roleId, displayName: 'Ana', language: 'en' });
    const mctx = { db, consumer: { id: cId, roleId }, channel: 'web', conversationId: 1 } as any;
    const specs = await buildToolSpecs(mctx);
    await specs.find((s) => s.name === 'messageAdmin')!.run(mctx, { message: 'TV broke' });
    const all = listMessages(db, {});
    expect(all[0]).toMatchObject({ consumerId: cId, body: 'TV broke' });
    expect(notify.notifyAdminsTracked).toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('messageAdmin refuses an empty message and does not notify or log', async () => {
    const notify = await import('../notify');
    const access = await import('../identity/access-log');
    const spyNotify = vi.spyOn(notify, 'notifyAdminsTracked').mockResolvedValue(undefined);
    const spyLog = vi.spyOn(access, 'logAccess').mockReturnValue(undefined as any);
    const { createRole } = await import('../identity/roles');
    const { createConsumer } = await import('../identity/consumers');
    const roleId = createRole(db, { name: 'M2', allowList: ['message_admin'], monthlyTokenCap: 1000, autoApprove: true, seerrQuota: {} });
    const cId = createConsumer(db, { roleId, displayName: 'Bo', language: 'en' });
    const mctx = { db, consumer: { id: cId, roleId }, channel: 'web', conversationId: 1 } as any;
    const specs = await buildToolSpecs(mctx);
    const tool = specs.find((s) => s.name === 'messageAdmin')!;
    const out: any = await tool.run(mctx, { message: '   ' });
    expect(out.ok).toBe(false);
    expect(spyNotify).not.toHaveBeenCalled();
    expect(spyLog).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it('toAiTools gives read tools an execute and write tools NONE (the confirmation gate)', async () => {
    createConnection(db, { type: 'stubsvc', name: 'S', baseUrl: 'http://x', secret: 'KEY', options: {} });
    const specs = await buildToolSpecs(ctx);
    const aiTools = toAiTools(ctx, specs);
    expect(typeof (aiTools.getWidget as any).execute).toBe('function');
    expect((aiTools.runAction as any).execute).toBeUndefined();
  });

  it('read tool execute truncates oversized results before they reach the model', async () => {
    const id = createConnection(db, { type: 'stubsvc', name: 'S', baseUrl: 'http://x', secret: 'KEY', options: {} });
    const specs = await buildToolSpecs(ctx);
    const aiTools = toAiTools(ctx, specs);
    const out: any = await (aiTools.getWidget as any).execute({ connectionId: id, widget: 'huge' });
    // The raw payload is ~320k chars; the model must never receive that much.
    expect(JSON.stringify(out).length).toBeLessThan(50_000);
    expect(out.data.truncated).toBe(true);
    expect(out.data.items.length).toBeGreaterThan(0);
  });
});
