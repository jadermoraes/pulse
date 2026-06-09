import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '$lib/server/db';
import * as dbmod from '$lib/server/db';
import { loadAiRefs } from '$lib/server/agent/provider';
import { createAiConnection } from '$lib/server/agent/ai-connections';
import { GET, POST } from './+server';

// Configurable mock for the AI SDK's generateText (the model-ref validation ping).
const generateTextMock = vi.hoisted(() => vi.fn());
vi.mock('ai', async (orig) => ({ ...(await orig() as any), generateText: generateTextMock }));

let db: DB;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  vi.spyOn(dbmod, 'getDb').mockReturnValue(db);
  generateTextMock.mockReset();
  generateTextMock.mockResolvedValue({ text: 'pong' } as any);
});
afterEach(() => vi.restoreAllMocks());

const user = { id: 1, email: 'admin' };

describe('/api/ai/config (reference shape)', () => {
  it('401 without a user', async () => {
    await expect(GET({ locals: { user: null } } as any)).rejects.toMatchObject({ status: 401 });
  });

  it('POST saves admin + consumer refs and GET returns them with the connection list (no keys)', async () => {
    const admin = createAiConnection(db, { label: 'Admin', provider: 'anthropic', apiKey: 'ADMIN' });
    const cons = createAiConnection(db, { label: 'Viewer', provider: 'anthropic', apiKey: 'VIEWER' });
    const body = JSON.stringify({
      adminConnectionId: admin, adminModel: 'claude-opus-4', adminTemperature: 0.2, validate: false,
      consumerConnectionId: cons, consumerModel: 'claude-haiku-4'
    });
    const res = await POST({ request: new Request('http://x', { method: 'POST', body }), locals: { user } } as any);
    expect((await res.json()).ok).toBe(true);

    const refs = loadAiRefs(db);
    expect(refs.adminConnectionId).toBe(admin);
    expect(refs.adminModel).toBe('claude-opus-4');
    expect(refs.consumerConnectionId).toBe(cons);
    expect(refs.consumerModel).toBe('claude-haiku-4');

    const get = await GET({ locals: { user } } as any);
    const payload = await get.json();
    expect(payload.adminConnectionId).toBe(admin);
    expect(payload.consumerModel).toBe('claude-haiku-4');
    expect(payload.connections).toHaveLength(2);
    // No plaintext keys anywhere in the GET payload.
    expect(JSON.stringify(payload)).not.toContain('ADMIN');
    expect(JSON.stringify(payload)).not.toContain('VIEWER');
    for (const c of payload.connections) expect('secret' in c).toBe(false);
  });

  it('the model-ref validation ping requests at least 16 output tokens (OpenAI minimum)', async () => {
    const admin = createAiConnection(db, { label: 'Admin', provider: 'openai', apiKey: 'ADMIN' });
    const body = JSON.stringify({ adminConnectionId: admin, adminModel: 'gpt-4o-mini' }); // validate defaults to on
    const res = await POST({ request: new Request('http://x', { method: 'POST', body }), locals: { user } } as any);
    expect((await res.json()).ok).toBe(true);
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const arg = generateTextMock.mock.calls[0][0];
    expect(arg.maxOutputTokens).toBeGreaterThanOrEqual(16);
  });

  it('POST 400s when the referenced admin connection does not exist', async () => {
    const body = JSON.stringify({ adminConnectionId: 999, adminModel: 'm', validate: false });
    await expect(
      POST({ request: new Request('http://x', { method: 'POST', body }), locals: { user } } as any)
    ).rejects.toMatchObject({ status: 400 });
  });
});
