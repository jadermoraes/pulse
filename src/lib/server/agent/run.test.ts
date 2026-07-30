import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { createConnection } from '../connections';
import { registerIntegration } from '../integrations/registry';
import type { Integration } from '../integrations/types';
import type { AgentContext } from './types';
import { __resetPending, getPending } from './confirm';
import type { AgentEvent } from './channel';

// Stub integration: one read widget, one write action.
const svc: Integration = {
  type: 'runsvc', label: 'Run', icon: 'x', configSchema: [],
  async testConnection() { return { ok: true, message: 'ok' }; },
  widgets: { queue: async () => ({ ok: true, data: [{ id: 1, title: 'Apex' }] }) },
  actions: { approve: { id: 'approve', label: 'Approve', kind: 'request',
    async run() { return { ok: true, message: 'approved' }; } } }
};
registerIntegration(svc);

// --- Mock the AI SDK streamText: scripted fullStream per call. -----------
// Call 1: a read tool-call (executes inline) → assistant text.
// Call 2 (after we feed it): a WRITE tool-call (no execute) → pause.
let callIndex = 0;
function fakeStream(parts: any[]) {
  return {
    fullStream: (async function* () { for (const p of parts) yield p; })(),
    // The loop reads usage from the 'finish' part; provide a resolved promise too.
    totalUsage: Promise.resolve({ inputTokens: 5, outputTokens: 7 }),
    // The loop awaits result.response to persist assistant message(s).
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
          { type: 'tool-call', toolName: 'getWidget', toolCallId: 't1',
            input: { connectionId: 1, widget: 'queue' }, dynamic: false },
          { type: 'tool-result', toolName: 'getWidget', toolCallId: 't1', output: { ok: true } },
          { type: 'text-delta', text: 'There is 1 item in the queue.' },
          { type: 'finish', finishReason: 'stop', totalUsage: { inputTokens: 5, outputTokens: 7 } }
        ]);
      }
      // second turn: a write tool-call with no execute → the loop must pause
      return fakeStream([
        { type: 'tool-call', toolName: 'runAction', toolCallId: 't2',
          input: { connectionId: 1, action: 'approve', params: { id: 7 } }, dynamic: false },
        { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 3, outputTokens: 4 } }
      ]);
    })
  };
});

import { runAgentTurn, sanitizeHistory } from './run';
import { listAudit } from './audit';
import { listEvents } from './events';
import * as eventsModule from './events';
import * as notify from '../notify';
import type { ModelMessage } from 'ai';

describe('sanitizeHistory — heal dangling tool-calls', () => {
  const userMsg = { role: 'user', content: 'hi' } as ModelMessage;
  const asstText = { role: 'assistant', content: [{ type: 'text', text: 'hello' }] } as unknown as ModelMessage;
  const asstCall = (id: string) =>
    ({ role: 'assistant', content: [{ type: 'tool-call', toolCallId: id, toolName: 't', input: {} }] }) as unknown as ModelMessage;
  const toolResult = (id: string) =>
    ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 't', output: { type: 'json', value: {} } }] }) as unknown as ModelMessage;

  it('keeps a complete tool exchange intact', () => {
    const h = [userMsg, asstCall('c1'), toolResult('c1'), asstText];
    expect(sanitizeHistory(h)).toHaveLength(4);
  });

  it('drops a trailing tool-call with no matching result (crashed write / abandoned confirm)', () => {
    const h = [userMsg, asstText, userMsg, asstCall('c9')];
    expect(sanitizeHistory(h)).toEqual([userMsg, asstText, userMsg]);
  });

  it('truncates everything from the first unanswered tool-call onward', () => {
    const h = [userMsg, asstCall('c1'), /* no result for c1 */ asstText];
    expect(sanitizeHistory(h)).toEqual([userMsg]);
  });

  it('keeps a partially-answered multi-call message and synthesizes results for dangling calls', () => {
    // The amnesia-loop repro: the model emitted [c1, c2, c3] in ONE message (e.g. "fix the
    // profile AND remove all three queue items"), the turn paused on c1, the admin approved it,
    // c1 ran and got a real result — but c2/c3 never ran. The OLD sanitizeHistory truncated the
    // whole message (all-or-nothing), erasing c1's real result, so the model forgot it had acted
    // and repeated the plan forever. Now the message + its real result must survive.
    const asstMulti = { role: 'assistant', content: [
      { type: 'tool-call', toolCallId: 'c1', toolName: 't', input: {} },
      { type: 'tool-call', toolCallId: 'c2', toolName: 't', input: {} },
      { type: 'tool-call', toolCallId: 'c3', toolName: 't', input: {} }
    ] } as unknown as ModelMessage;
    const out = sanitizeHistory([userMsg, asstMulti, toolResult('c1')]);

    // The assistant message and c1's real result are retained (no amnesia).
    expect(out).toContain(asstMulti);
    // Every tool-call now has a result, so the provider will accept the history.
    const answered = new Set<string>();
    for (const m of out)
      for (const p of ((m as any).content ?? []))
        if (p?.type === 'tool-result') answered.add(p.toolCallId);
    expect([...answered].sort()).toEqual(['c1', 'c2', 'c3']);
    // The synthesized results are marked superseded — NOT faked as success.
    const synth = out
      .flatMap((m) => ((m as any).content ?? []))
      .find((p: any) => p?.type === 'tool-result' && p.toolCallId === 'c2');
    expect((synth.output.value as any).superseded).toBe(true);
  });

  it('leaves plain conversations untouched', () => {
    const h = [userMsg, asstText, userMsg, asstText];
    expect(sanitizeHistory(h)).toHaveLength(4);
  });
});

let db: DB; let ctx: AgentContext; let events: AgentEvent[];
beforeEach(() => {
  callIndex = 0; __resetPending();
  db = openDb(':memory:'); migrate(db);
  createConnection(db, { type: 'runsvc', name: 'S', baseUrl: 'http://x', secret: 'KEY', options: {} });
  ctx = { db, user: { id: 1, email: 'a@b.com' }, channel: 'web', conversationId: 1 };
  events = [];
  // a configured model so run.ts proceeds (modelFromConfig mocked via provider? we set ai_config)
  db.prepare("insert into settings(key,value) values('ai_config',?)")
    .run(JSON.stringify({ provider: 'openai', model: 'gpt-4o-mini', apiKeyEnc: null }));
  db.prepare('insert into ai_conversations(id,created_at) values(1,?)').run(Date.now());
});
afterEach(() => vi.restoreAllMocks());

describe('runAgentTurn — read flow', () => {
  it('streams tool_call + tool_result + text + done for a read query', async () => {
    await runAgentTurn(ctx, { send: (e) => { events.push(e); } }, 'how many in the queue?');
    const types = events.map((e) => e.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('text');
    expect(types.at(-1)).toBe('done');
    const done = events.at(-1) as any;
    expect(done.usage.total).toBeGreaterThan(0);
  });
});

describe('runAgentTurn — write flow (confirmation gate)', () => {
  it('pauses on a write tool-call, registers a pending action, emits confirmation_required', async () => {
    callIndex = 1; // jump straight to the write-tool script on the first streamText call
    await runAgentTurn(ctx, { send: (e) => { events.push(e); } }, 'approve request 7');
    const conf = events.find((e) => e.type === 'confirmation_required') as any;
    expect(conf).toBeTruthy();
    expect(conf.tool).toBe('runAction');
    expect(conf.summary).toContain('approve');
    // a pending action exists and was NOT executed
    expect(getPending(conf.pendingId)).toBeTruthy();
    // the loop ends the turn (no 'done' with a result for the write yet)
    expect(events.find((e) => e.type === 'tool_result' && (e as any).tool === 'runAction')).toBeUndefined();
  });
});

describe('runAgentTurn — admin apiWrite confirm flow', () => {
  it('pauses on an apiWrite tool-call and emits confirmation_required carrying the summary', async () => {
    const { streamText: mockedStreamText } = await import('ai');
    // Script ONE turn: the model emits an apiWrite write tool-call (no execute) → the loop
    // must pause at the same pending-action gate the curated write tools use.
    vi.mocked(mockedStreamText).mockImplementationOnce(() => fakeStream([
      { type: 'tool-call', toolName: 'apiWrite', toolCallId: 'aw1',
        input: { connectionId: 1, method: 'POST', path: '/api/v3/series',
          body: { tvdbId: 9999 }, summary: 'Add The Bear to Sonarr' }, dynamic: false },
      { type: 'finish', finishReason: 'tool-calls', totalUsage: { inputTokens: 3, outputTokens: 4 } }
    ]) as any);
    await runAgentTurn(ctx, { send: (e) => { events.push(e); } }, 'add The Bear to Sonarr');
    const conf = events.find((e) => e.type === 'confirmation_required') as any;
    expect(conf).toBeTruthy();
    expect(conf.tool).toBe('apiWrite');
    // The admin approves on the summary the model provided.
    expect(conf.summary).toBe('Add The Bear to Sonarr');
    // A pending action exists and the write was NOT executed (no real HTTP call asserted).
    expect(getPending(conf.pendingId)).toBeTruthy();
    expect(events.find((e) => e.type === 'tool_result' && (e as any).tool === 'apiWrite')).toBeUndefined();
  });
});

describe('runAgentTurn — error recording (Win 2)', () => {
  it('records a turn_error audit row when streamText throws, and sends an error event', async () => {
    const { streamText: mockedStreamText } = await import('ai');
    // Override the mock for ONE call: streamText throws (simulates provider error / network failure).
    vi.mocked(mockedStreamText).mockImplementationOnce(() => {
      throw new Error('upstream provider timeout');
    });
    await runAgentTurn(ctx, { send: (e) => { events.push(e); } }, 'will this error?');
    // Channel received an error event.
    const errEvent = events.find((e) => e.type === 'error') as any;
    expect(errEvent).toBeTruthy();
    expect(errEvent.message).toContain('timeout');
    // An audit row with tool='turn_error' was recorded (Win 2 — visible in Activity list).
    const auditRows = listAudit(db, { limit: 10 });
    const errRow = auditRows.find((r) => r.tool === 'turn_error');
    expect(errRow).toBeTruthy();
    expect((errRow!.result as any).message).toContain('timeout');
    expect(errRow!.confirmed).toBe(false);
  });

  it('fires a crit admin alert + surfaces the real provider message on a credit/API error', async () => {
    const recordEventSpy = vi.spyOn(eventsModule, 'recordEvent');
    const notifySpy = vi.spyOn(notify, 'notifyAdmins').mockResolvedValue(undefined);
    const { streamText: mockedStreamText } = await import('ai');
    // Script a stream whose 'error' part carries a real provider credit-balance error.
    vi.mocked(mockedStreamText).mockImplementationOnce(() => ({
      fullStream: (async function* () {
        yield { type: 'error', error: new Error('AI_APICallError: Your credit balance is too low to access the Anthropic API.') };
      })(),
      response: Promise.resolve({ messages: [] }),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0 })
    } as any));
    await runAgentTurn(ctx, { send: (e) => { events.push(e); } }, 'is the provider down?');

    // (a) the turn_error audit row still records the REAL provider message.
    const auditRows = listAudit(db, { limit: 10 });
    const errRow = auditRows.find((r) => r.tool === 'turn_error');
    expect(errRow).toBeTruthy();
    expect((errRow!.result as any).message).toContain('credit balance');

    // (b) recordEvent was called with a crit ai_provider_error event.
    expect(recordEventSpy).toHaveBeenCalled();
    const critCall = recordEventSpy.mock.calls.find(
      ([, ev]) => (ev as any).type === 'ai_provider_error'
    );
    expect(critCall).toBeTruthy();
    expect((critCall![1] as any).severity).toBe('crit');
    expect((critCall![1] as any).dedupeKey).toBe('ai_provider_error');
    // And it landed in the events table as a crit row.
    const critEvent = listEvents(db).find((e) => e.type === 'ai_provider_error');
    expect(critEvent?.severity).toBe('crit');

    // (c) the channel surfaced the real provider message (not a generic string).
    const errEvent = events.find((e) => e.type === 'error') as any;
    expect(errEvent.message).toContain('credit balance');

    // (d) a NEW provider-error event also pushes to admins (Telegram), not just the feed.
    expect(notifySpy).toHaveBeenCalledWith(
      db, expect.objectContaining({ body: expect.stringContaining('credit balance') })
    );
  });

  it('does NOT fire a crit admin alert for a generic (non-provider) error', async () => {
    const recordEventSpy = vi.spyOn(eventsModule, 'recordEvent');
    const notifySpy = vi.spyOn(notify, 'notifyAdmins').mockResolvedValue(undefined);
    const { streamText: mockedStreamText } = await import('ai');
    // A generic application error that is NOT API/credit/quota/rate-limit class.
    vi.mocked(mockedStreamText).mockImplementationOnce(() => {
      throw new Error('something went sideways in tool plumbing');
    });
    await runAgentTurn(ctx, { send: (e) => { events.push(e); } }, 'generic boom?');

    // The turn_error audit row is still recorded (existing behavior).
    const errRow = listAudit(db, { limit: 10 }).find((r) => r.tool === 'turn_error');
    expect(errRow).toBeTruthy();
    // But the regex gate blocks the crit alert: no ai_provider_error event.
    const fired = recordEventSpy.mock.calls.some(([, ev]) => (ev as any).type === 'ai_provider_error');
    expect(fired).toBe(false);
    expect(listEvents(db).find((e) => e.type === 'ai_provider_error')).toBeUndefined();
    // And no admin push for a non-provider error.
    expect(notifySpy).not.toHaveBeenCalled();
  });

  it('records only ONE audit row even when the error stream part and catch both fire', async () => {
    const { streamText: mockedStreamText } = await import('ai');
    // Script a stream that emits an 'error' part AND THEN throws from the async generator.
    vi.mocked(mockedStreamText).mockImplementationOnce(() => ({
      fullStream: (async function* () {
        yield { type: 'error', error: 'provider rate-limit' };
        throw new Error('provider rate-limit'); // also throws after the error part
      })(),
      response: Promise.resolve({ messages: [] }),
      totalUsage: Promise.resolve({ inputTokens: 0, outputTokens: 0 })
    } as any));
    await runAgentTurn(ctx, { send: (e) => { events.push(e); } }, 'double error?');
    const auditRows = listAudit(db, { limit: 10 });
    const errRows = auditRows.filter((r) => r.tool === 'turn_error');
    // Must be exactly one — the dedupe guard prevents double-recording.
    expect(errRows).toHaveLength(1);
  });
});
