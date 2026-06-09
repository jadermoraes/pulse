import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import * as dbmod from '$lib/server/db';
import { createAiConnection } from '$lib/server/agent/ai-connections';
import { GET } from './+server';

let db: DB;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  vi.spyOn(dbmod, 'getDb').mockReturnValue(db);
});
afterEach(() => vi.restoreAllMocks());

const user = { id: 1, email: 'admin' };
const req = (id: number | string) =>
  ({ url: new URL(`http://x/api/ai/models?connectionId=${id}`), locals: { user } } as any);

describe('/api/ai/models', () => {
  it('401 without a user', async () => {
    await expect(GET({ url: new URL('http://x'), locals: { user: null } } as any))
      .rejects.toMatchObject({ status: 401 });
  });

  it('400 when connectionId is missing or unknown', async () => {
    await expect(GET({ url: new URL('http://x/api/ai/models'), locals: { user } } as any))
      .rejects.toMatchObject({ status: 400 });
    await expect(GET(req(999))).rejects.toMatchObject({ status: 400 });
  });

  it('Anthropic: fetches v1/models with x-api-key, marks recommended, never returns the key', async () => {
    const id = createAiConnection(db, { label: 'A', provider: 'anthropic', apiKey: 'sk-anthropic' });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'claude-sonnet-4-20250101' }, { id: 'claude-3-5-haiku-latest' }, { id: 'claude-3-opus' }]
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(req(id));
    const payload = await res.json();
    expect(fetchMock).toHaveBeenCalledWith('https://api.anthropic.com/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ 'x-api-key': 'sk-anthropic', 'anthropic-version': '2023-06-01' })
    }));
    const ids = payload.models.map((m: any) => m.id);
    expect(ids).toContain('claude-sonnet-4-20250101');
    const sonnet = payload.models.find((m: any) => m.id === 'claude-sonnet-4-20250101');
    expect(sonnet.recommended).toBe(true);
    expect(payload.fallback).toBeFalsy();
    expect(JSON.stringify(payload)).not.toContain('sk-anthropic');
  });

  it('OpenAI: fetches v1/models with a Bearer token', async () => {
    const id = createAiConnection(db, { label: 'O', provider: 'openai', apiKey: 'sk-openai' });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }, { id: 'whisper-1' }]
    }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(req(id));
    const payload = await res.json();
    expect(fetchMock).toHaveBeenCalledWith('https://api.openai.com/v1/models', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Bearer sk-openai' })
    }));
    const fourO = payload.models.find((m: any) => m.id === 'gpt-4o');
    expect(fourO.recommended).toBe(true);
  });

  it('openai-compatible: fetches {baseUrl}/v1/models', async () => {
    const id = createAiConnection(db, { label: 'C', provider: 'openai-compatible', baseUrl: 'http://ollama:11434' });
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'llama3.1' }] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await GET(req(id));
    const payload = await res.json();
    expect(fetchMock).toHaveBeenCalledWith('http://ollama:11434/v1/models', expect.anything());
    expect(payload.models.map((m: any) => m.id)).toContain('llama3.1');
  });

  it('returns a curated fallback list with fallback:true when the provider fetch fails', async () => {
    const id = createAiConnection(db, { label: 'A', provider: 'anthropic', apiKey: 'sk' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));

    const res = await GET(req(id));
    const payload = await res.json();
    expect(payload.fallback).toBe(true);
    expect(payload.models.length).toBeGreaterThan(0);
    expect(payload.models.some((m: any) => m.recommended)).toBe(true);
  });

  it('returns the fallback list on a non-2xx response', async () => {
    const id = createAiConnection(db, { label: 'O', provider: 'openai', apiKey: 'sk' });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 401 })));
    const res = await GET(req(id));
    const payload = await res.json();
    expect(payload.fallback).toBe(true);
    expect(payload.models.length).toBeGreaterThan(0);
  });
});
