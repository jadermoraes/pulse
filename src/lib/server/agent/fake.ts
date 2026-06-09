// Deterministic, hermetic agent driver used ONLY when PULSE_AGENT_FAKE=1.
//
// It replaces the real LLM token generation in `driveLoop` (run.ts) but keeps the
// rest of the server path REAL: read tools run their genuine `run(ctx, args)` (so DB
// effects are real), write tools register a real pending action via `registerPending`
// and emit `confirmation_required` exactly like the production loop, and the confirm
// endpoint then runs the real `executeConfirmed` → resolveAction/docker → audit path.
//
// Only the decision of "which tool to call" and the wording of the assistant text are
// scripted (keyed off the latest user message), making the e2e flows deterministic
// without a real provider, network, or external services.
import type { DB } from '../db';
import type { ModelMessage } from 'ai';
import { buildToolSpecs } from './tools';
import { registerPending } from './confirm';
import type { AgentContext, ToolSpec } from './types';
import type { Channel } from './channel';

/** The most recent user message text in the conversation (lowercased), or ''. */
function lastUserMessage(db: DB, conversationId: number): string {
  const rows = db.prepare(
    "select content from ai_messages where conversation_id=? and role='user' order by id desc limit 1"
  ).all(conversationId) as Array<{ content: string }>;
  if (!rows.length) return '';
  try {
    const msg = JSON.parse(rows[0].content) as ModelMessage;
    const c = (msg as { content?: unknown }).content;
    if (typeof c === 'string') return c.toLowerCase();
    if (Array.isArray(c)) {
      return c
        .map((p) => (typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : ''))
        .join(' ')
        .toLowerCase();
    }
  } catch { /* fall through */ }
  return '';
}

/** True when the loop is being resumed after a confirmation (last message is a tool result). */
function isResume(db: DB, conversationId: number): boolean {
  const row = db.prepare(
    'select role from ai_messages where conversation_id=? order by id desc limit 1'
  ).get(conversationId) as { role: string } | undefined;
  return row?.role === 'tool';
}

function appendAssistantText(db: DB, conversationId: number, text: string): void {
  const msg: ModelMessage = { role: 'assistant', content: text } as ModelMessage;
  db.prepare('insert into ai_messages(conversation_id,role,content,tokens,ts) values (?,?,?,?,?)')
    .run(conversationId, 'assistant', JSON.stringify(msg), 0, Date.now());
}

const DONE_USAGE = { input: 10, output: 10, total: 20 };

/**
 * Scripted replacement for `driveLoop`. Mirrors the real event sequence:
 *  - READ flow  ("queue"/"playing"/"status"/"wrong"/"events"): emit tool_call + run the
 *    real read spec + tool_result + assistant text + done.
 *  - WRITE flow ("restart"/"approve"/"stop"): emit tool_call, register a real pending
 *    action, emit confirmation_required, and STOP (the turn yields to the user).
 *  - RESUME (last message is a tool result from /api/agent/confirm): emit text + done.
 */
export async function fakeDrive(ctx: AgentContext, channel: Channel): Promise<void> {
  const { db, conversationId } = ctx;

  // Resuming after a confirmation: the write already ran + was audited; just wrap up.
  if (isResume(db, conversationId)) {
    const text = 'Done — the action completed.';
    channel.send({ type: 'text', delta: text });
    appendAssistantText(db, conversationId, text);
    channel.send({ type: 'done', usage: DONE_USAGE });
    return;
  }

  const msg = lastUserMessage(db, conversationId);
  const specs = await buildToolSpecs(ctx);
  const byName = new Map<string, ToolSpec>(specs.map((s) => [s.name, s]));

  const wantsWrite = /\b(restart|stop|approve|remove|delete|pause|resume)\b/.test(msg);

  if (wantsWrite) {
    // WRITE flow — register a REAL pending action and pause, exactly like the live loop.
    const spec =
      byName.get('restartContainer') ?? specs.find((s) => s.risk === 'write');
    if (!spec) {
      const text = 'There are no write actions available right now.';
      channel.send({ type: 'text', delta: text });
      appendAssistantText(db, conversationId, text);
      channel.send({ type: 'done', usage: DONE_USAGE });
      return;
    }
    const args: Record<string, unknown> =
      spec.name === 'restartContainer' ? { id: 'jellyfin' } : {};
    channel.send({ type: 'tool_call', tool: spec.name, args });
    const summary = spec.summarize?.(ctx, args) ?? `Run ${spec.name}`;
    const pendingId = registerPending({ conversationId, tool: spec.name, args, summary });
    channel.send({ type: 'confirmation_required', pendingId, tool: spec.name, summary, args });
    // Turn yields to the user; no 'done' (matches the real loop's paused branch).
    return;
  }

  // READ flow — run a genuine read spec so the response reflects real DB state.
  const readSpec = byName.get('getEvents') ?? byName.get('listConnections') ?? specs[0];
  if (readSpec) {
    const args = readSpec.name === 'getEvents' ? { limit: 10 } : {};
    channel.send({ type: 'tool_call', tool: readSpec.name, args });
    let result: unknown;
    try { result = await readSpec.run(ctx, args); }
    catch (e) { result = { ok: false, error: (e as Error).message }; }
    channel.send({ type: 'tool_result', tool: readSpec.name, result });
  }

  const text = "Here's what I found from the homelab.";
  channel.send({ type: 'text', delta: text });
  appendAssistantText(db, conversationId, text);
  channel.send({ type: 'done', usage: DONE_USAGE });
}
