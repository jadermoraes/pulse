import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import * as dbmod from '$lib/server/db';
import { listAiConnections, getAiConnection } from '$lib/server/agent/ai-connections';
import { GET, POST, PUT, DELETE } from './+server';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  vi.spyOn(dbmod, 'getDb').mockReturnValue(db);
  // Validation lists models via fetch; default to a healthy 200 with a model list.
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 })));
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const user = { id: 1, email: 'admin' };
const post = (body: any) =>
  POST({ request: new Request('http://x', { method: 'POST', body: JSON.stringify(body) }), locals: { user } } as any);

describe('/api/ai/connections', () => {
  it('401 without a user on every verb', async () => {
    await expect(GET({ locals: { user: null } } as any)).rejects.toMatchObject({ status: 401 });
    await expect(POST({ request: new Request('http://x', { method: 'POST', body: '{}' }), locals: { user: null } } as any))
      .rejects.toMatchObject({ status: 401 });
  });

  it('GET lists connections without secrets', async () => {
    await post({ label: 'A', provider: 'anthropic', apiKey: 'sk', validate: false });
    const res = await GET({ locals: { user } } as any);
    const payload = await res.json();
    expect(payload.connections).toHaveLength(1);
    expect('secret' in payload.connections[0]).toBe(false);
    expect(payload.connections[0].hasKey).toBe(true);
    expect(JSON.stringify(payload)).not.toContain('sk');
  });

  it('POST creates a connection (key encrypted) and returns ok + id', async () => {
    const res = await post({ label: 'A', provider: 'anthropic', apiKey: 'sk-secret', validate: false });
    const payload = await res.json();
    expect(payload.ok).toBe(true);
    expect(payload.id).toEqual(expect.any(Number));
    const conn = getAiConnection(db, payload.id)!;
    expect(conn.secret).toBe('sk-secret');
    const rawRow = db.prepare('select secret from ai_connections where id=?').get(payload.id) as any;
    expect(rawRow.secret).toContain('v1:');
  });

  it('POST validates by listing models and rolls back a rejected key (401)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('unauthorized', { status: 401 })));
    const res = await post({ label: 'A', provider: 'anthropic', apiKey: 'wrong' });
    const payload = await res.json();
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('Invalid API key');
    expect(listAiConnections(db)).toHaveLength(0);
  });

  it('POST saves when the models-list validation returns 2xx', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'm' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await post({ label: 'A', provider: 'anthropic', apiKey: 'good' });
    expect((await res.json()).ok).toBe(true);
    expect(listAiConnections(db)).toHaveLength(1);
    // It validated via the provider's models endpoint, not by generating text.
    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ 'x-api-key': 'good' })
    }));
  });

  it('POST surfaces a friendly error and rolls back when the provider is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const res = await post({ label: 'A', provider: 'anthropic', apiKey: 'x' });
    const payload = await res.json();
    expect(payload.ok).toBe(false);
    expect(payload.error).toBe('Could not reach provider');
    expect(listAiConnections(db)).toHaveLength(0);
  });

  it('POST validates a keyless local connection by reaching /v1/models', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'llama' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const res = await post({ label: 'L', provider: 'openai-compatible', baseUrl: 'http://ollama:11434' });
    expect((await res.json()).ok).toBe(true);
    expect(listAiConnections(db)).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith('http://ollama:11434/v1/models', expect.anything());
  });

  it('PUT updates a connection', async () => {
    const created = await (await post({ label: 'A', provider: 'anthropic', apiKey: 'k', validate: false })).json();
    const res = await PUT({
      request: new Request('http://x', { method: 'PUT', body: JSON.stringify({ id: created.id, label: 'A2', validate: false }) }),
      locals: { user }
    } as any);
    expect((await res.json()).ok).toBe(true);
    expect(getAiConnection(db, created.id)!.label).toBe('A2');
  });

  it('DELETE removes a connection', async () => {
    const created = await (await post({ label: 'A', provider: 'anthropic', apiKey: 'k', validate: false })).json();
    const res = await DELETE({
      request: new Request('http://x', { method: 'DELETE', body: JSON.stringify({ id: created.id }) }),
      locals: { user }
    } as any);
    expect((await res.json()).ok).toBe(true);
    expect(listAiConnections(db)).toHaveLength(0);
  });
});
