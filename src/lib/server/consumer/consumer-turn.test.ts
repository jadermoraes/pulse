import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { streamText } from 'ai';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { openDb, migrate, type DB } from '../db';
import { createRole } from '../identity/roles';
import { createConsumer } from '../identity/consumers';
import { addUsage } from '../identity/usage';
import type { ToolSpec } from '../agent/types';
import { scopeConsumerSpecs, consumerCapGate, consumerSystemMessage } from './consumer-turn';

let db: DB; let roleId: number; let consumerId: number;
beforeEach(() => {
  db = openDb(':memory:'); migrate(db);
  roleId = createRole(db, { name: 'Member', allowList: ['discover', 'request'], monthlyTokenCap: 1000, autoApprove: false, seerrQuota: {} });
  consumerId = createConsumer(db, { roleId, displayName: 'Ana', language: 'en' });
});
afterEach(() => vi.restoreAllMocks());

const spec = (name: string): ToolSpec => ({ name, risk: 'read', category: 'system', description: '', run: async () => ({}) });

describe('consumer turn scoping + cap gate', () => {
  it('keeps only allow-listed tools; excludes admin/system tools', () => {
    const specs = [spec('getWidget'), spec('getMediaDetail'), spec('runAction'), spec('listContainers'), spec('getServerStats')];
    const scoped = scopeConsumerSpecs(specs, ['discover', 'request']);
    const names = scoped.map((s) => s.name).sort();
    // getWidget+getMediaDetail (discover), runAction (request); container/server tools (ungoverned) excluded
    expect(names).toEqual(['getMediaDetail', 'getWidget', 'runAction']);
  });

  it('an empty allow-list yields no tools', () => {
    expect(scopeConsumerSpecs([spec('getWidget')], [])).toEqual([]);
  });

  it('cap gate: under cap allows, at/over cap blocks', () => {
    expect(consumerCapGate(db, consumerId, roleId).blocked).toBe(false);
    addUsage(db, consumerId, 1000);
    expect(consumerCapGate(db, consumerId, roleId).blocked).toBe(true);
  });
});

describe('prompt caching wiring', () => {
  it('marks the system message with anthropic ephemeral cacheControl', () => {
    const sys = consumerSystemMessage();
    expect(sys.role).toBe('system');
    expect(sys.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
    expect(typeof sys.content).toBe('string');
  });

  it('the cacheControl providerOptions reach the model layer on the system message', async () => {
    // Capture the prompt streamText actually hands to the provider. The Anthropic provider
    // reads cacheControl from THIS system message's providerOptions (per-message, not top-level).
    let seenPrompt: any;
    const model = new MockLanguageModelV3({
      doStream: async (opts: any) => {
        seenPrompt = opts.prompt;
        return {
          stream: convertArrayToReadableStream([
            { type: 'text-start', id: '1' },
            { type: 'text-delta', id: '1', delta: 'ok' },
            { type: 'text-end', id: '1' },
            { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }
          ])
        };
      }
    } as any);
    const result = streamText({ model, system: consumerSystemMessage(), messages: [{ role: 'user', content: 'hi' }] });
    // Drain so doStream runs.
    for await (const _ of result.fullStream) { /* drain */ }
    const sysMsg = seenPrompt.find((m: any) => m.role === 'system');
    expect(sysMsg).toBeTruthy();
    expect(sysMsg.providerOptions).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
  });
});
