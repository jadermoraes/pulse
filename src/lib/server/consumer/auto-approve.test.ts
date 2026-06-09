import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { createConnection } from '../connections';
import { registerIntegration } from '../integrations/registry';
import type { Integration } from '../integrations/types';
import { createRole } from '../identity/roles';
import { createConsumer } from '../identity/consumers';
import type { AgentContext } from '../agent/types';
import type { AgentEvent } from '../agent/channel';
import { listAudit } from '../agent/audit';

// A service with one write 'request' action whose effect we can observe.
const svc: Integration = {
  type: 'reqsvc', label: 'Req', icon: 'x', configSchema: [],
  async testConnection() { return { ok: true, message: 'ok' }; },
  widgets: {},
  actions: { request: { id: 'request', label: 'R', kind: 'request',
    async run(_c, p) { return { ok: true, message: 'Requested', echoed: p }; } } }
};
registerIntegration(svc);

// Scripted streamText: call 1 emits a write tool-call (auto-exec path); call 2 wraps up.
let callIndex = 0;
function fakeStream(parts: any[]) {
  return {
    fullStream: (async function* () { for (const p of parts) yield p; })(),
    totalUsage: Promise.resolve({ inputTokens: 5, outputTokens: 7 }),
    response: Promise.resolve({ messages: [] })
  };
}
vi.mock('ai', async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    streamText: vi.fn(() => {
      callIndex += 1;
      if (callIndex === 1) {
        return fakeStream([
          { type: 'tool-call', toolName: 'runAction', toolCallId: 'w1',
            input: { connectionId: 1, action: 'request', params: { mediaType: 'movie', tmdbId: 9 } }, dynamic: false },
          { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 5, outputTokens: 7 } }
        ]);
      }
      return fakeStream([
        { type: 'text-delta', text: 'Requested it for you.' },
        { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 2, outputTokens: 3 } }
      ]);
    })
  };
});

// Make getConsumerModel return a truthy model.
vi.mock('../agent/provider', async (orig) => {
  const real: any = await orig();
  return { ...real, getConsumerModel: vi.fn(() => ({}) as any) };
});

import { runConsumerTurn } from './consumer-turn';

let db: DB; let roleId: number; let consumerId: number; let ctx: AgentContext; let events: AgentEvent[];
beforeEach(() => {
  callIndex = 0;
  db = openDb(':memory:'); migrate(db);
  createConnection(db, { type: 'reqsvc', name: 'R', baseUrl: 'http://x', secret: 'KEY', options: {} });
  // auto-approve role with 'request' capability.
  roleId = createRole(db, { name: 'Auto', allowList: ['request'], monthlyTokenCap: 100000, autoApprove: true, seerrQuota: {} });
  consumerId = createConsumer(db, { roleId, displayName: 'Ana', language: 'en' });
  const conv = Number(db.prepare('insert into ai_conversations(title,created_at,consumer_id) values(?,?,?)')
    .run(null, Date.now(), consumerId).lastInsertRowid);
  ctx = { db, user: { id: 0, email: 'consumer' }, channel: 'web', conversationId: conv, consumer: { id: consumerId, roleId } };
  events = [];
});
afterEach(() => vi.restoreAllMocks());

describe('consumer auto-approved write runs inline (no card)', () => {
  it('executes the write, emits a tool_result (not confirmation_required), and audits it', async () => {
    await runConsumerTurn(ctx, { send: (e) => { events.push(e); } }, 'request The Matrix');
    const types = events.map((e) => e.type);
    // No confirmation card for an auto-approved consumer write.
    expect(types).not.toContain('confirmation_required');
    // The write actually ran and surfaced a tool_result.
    const res = events.find((e) => e.type === 'tool_result' && (e as any).tool === 'runAction') as any;
    expect(res).toBeTruthy();
    expect(JSON.stringify(res.result)).toContain('Requested');
    // It was audited as a confirmed action.
    const audit = listAudit(db, { limit: 10 });
    expect(audit.some((a) => a.tool === 'runAction' && a.confirmed)).toBe(true);
    // The turn completed.
    expect(types.at(-1)).toBe('done');
  });
});
