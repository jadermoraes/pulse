import { streamText, stepCountIs } from 'ai';
import type { ModelMessage, SystemModelMessage } from 'ai';
import { logAccess } from '../identity/access-log';
import type { DB } from '../db';
import type { AgentContext, ToolSpec } from '../agent/types';
import type { Channel } from '../agent/channel';
import { buildToolSpecs, toAiTools } from '../agent/tools';
import { policy } from '../agent/policy';
import { executeWriteInline, sanitizeHistory } from '../agent/run';
import { toolAllowed } from '../identity/capabilities';
import type { Capability } from '../identity/types';
import { getConsumer, effectiveAllowList } from '../identity/consumers';
import { getRole } from '../identity/roles';
import { addUsage, isOverCap } from '../identity/usage';
import { getConsumerModel, loadAiRefs } from '../agent/provider';
import { recordUsage } from '../agent/cost';
import { CACHE_OPTS, withHistoryCacheMarker } from '../agent/cache';
import { usageFromResult } from '../agent/usage';

const MAX_STEPS = 6;

export { CACHE_OPTS };

/** The system prompt as a cache-marked system message so the prefix is actually cached. */
export function consumerSystemMessage(): SystemModelMessage {
  return { role: 'system', content: consumerSystemPrompt(), providerOptions: CACHE_OPTS };
}

function consumerSystemPrompt(): string {
  return [
    'You are Pulse, a friendly media assistant for a home media server.',
    'You help one household member discover what to watch, request and track titles, save things for later, and reach the admin.',
    'Rules:',
    '- Use the read tools to learn what is on the server before recommending.',
    '- To request a title (or answer questions about a specific movie/show), FIRST call `searchMedia`',
    '  to get the exact `tmdbId` and `mediaType`. NEVER invent, guess, or recall a tmdbId from memory —',
    '  always use the tmdbId returned by `searchMedia`. Then call the request action with that exact',
    '  tmdbId + mediaType.',
    '- To request a missing title, call the request tool directly — only titles the user asks for.',
    '  Do NOT ask the user to confirm in your reply or wait for them to type a confirmation;',
    '  the app handles approval via its own UI. Do not claim success until the tool result returns.',
    '- Be warm and concise. Never mention admin features, other users, secrets, or system internals.',
    '- watchlistAdd saves a title for later; if it is not on the server yet the viewer is notified when',
    '  it arrives. watchlistList shows their list; watchlistRemove removes one. Use searchMedia for the tmdbId first.',
    '- myRequests answers "where is my request for X?" with its status. cancelRequest cancels ONLY the',
    '  viewer\'s own request.',
    '- messageAdmin forwards a short message or problem report to the server admin — use it when the',
    '  viewer is stuck or asks you to tell the admin something.',
    '- You only have the tools you are given; never claim abilities beyond them.'
  ].join('\n');
}

/** Pure: keep only specs whose tool name is permitted by the allow-list. */
export function scopeConsumerSpecs(specs: ToolSpec[], allowList: string[]): ToolSpec[] {
  return specs.filter((s) => toolAllowed(s.name, allowList as Capability[]));
}

/** Pure-ish: is this consumer over their effective cap right now? */
export function consumerCapGate(db: DB, consumerId: number, roleId: number): { blocked: boolean } {
  const consumer = getConsumer(db, consumerId);
  const role = getRole(db, roleId);
  if (!consumer || !role) return { blocked: true };
  return { blocked: isOverCap(db, consumer, role) };
}

function loadHistory(db: DB, conversationId: number): ModelMessage[] {
  return sanitizeHistory(
    (db.prepare('select content from ai_messages where conversation_id=? order by id')
      .all(conversationId) as Array<{ content: string }>).map((r) => JSON.parse(r.content) as ModelMessage)
  );
}
function appendMessage(db: DB, conversationId: number, msg: ModelMessage, consumerId: number): void {
  db.prepare('insert into ai_messages(conversation_id,role,content,tokens,ts,consumer_id) values (?,?,?,?,?,?)')
    .run(conversationId, (msg as { role?: string }).role ?? 'assistant', JSON.stringify(msg), 0, Date.now(), consumerId);
}

export async function runConsumerTurn(
  ctx: AgentContext, channel: Channel, userMessage: string, signal?: AbortSignal
): Promise<void> {
  if (!ctx.consumer) { channel.send({ type: 'error', message: 'Not a consumer turn' }); return; }
  const { id: consumerId, roleId } = ctx.consumer;

  // Cap-gate at turn start — discover/requests/watch keep working since they don't hit the LLM.
  if (consumerCapGate(ctx.db, consumerId, roleId).blocked) {
    channel.send({ type: 'blocked', reason: 'cap' });
    return;
  }

  appendMessage(ctx.db, ctx.conversationId, { role: 'user', content: userMessage } as ModelMessage, consumerId);
  logAccess(ctx.db, { consumerId, type: 'chat' }); // event only — no message content (privacy)

  if (process.env.PULSE_AGENT_FAKE === '1') {
    const { fakeDrive } = await import('../agent/fake');
    await fakeDrive(ctx, channel);
    addUsage(ctx.db, consumerId, 100); // deterministic metering for tests
    return;
  }

  const model = getConsumerModel(ctx.db);
  if (!model) { channel.send({ type: 'error', message: 'No consumer model configured' }); return; }

  await driveConsumerLoop(ctx, channel, consumerId, roleId, signal);
}

/**
 * Stream one consumer step. Read tools run inline (SDK). For an auto-approved write
 * (policy {allow:true, confirm:false}) we run the effect server-side and re-drive so the
 * model narrates the result — consumer chat has no confirm card. Denied writes surface a
 * denied tool result. Re-drives at most MAX_STEPS deep via the AI-SDK step budget.
 */
async function driveConsumerLoop(
  ctx: AgentContext, channel: Channel, consumerId: number, roleId: number, signal?: AbortSignal
): Promise<void> {
  const consumer = getConsumer(ctx.db, consumerId)!;
  const role = getRole(ctx.db, roleId)!;
  const allow = effectiveAllowList(consumer, role) as unknown as string[];
  const specs = scopeConsumerSpecs(await buildToolSpecs(ctx), allow);
  const specByName = new Map(specs.map((s) => [s.name, s]));
  const aiTools = toAiTools(ctx, specs);
  const messages = loadHistory(ctx.db, ctx.conversationId);

  let usage = { input: 0, output: 0, cached: 0 };
  try {
    const result = streamText({
      model: getConsumerModel(ctx.db)!,
      // Cache-marked system message: providerOptions ride WITH the system part, which is where
      // the Anthropic provider reads cacheControl and emits the cache_control breakpoint.
      system: consumerSystemMessage(),
      // History breakpoint (send-time only): follow-up turns re-read the conversation at ~10%
      // of the input rate instead of full price.
      messages: withHistoryCacheMarker(messages),
      tools: aiTools,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: signal
    });
    let autoResume = false;
    for await (const part of result.fullStream) {
      if (signal?.aborted) return;
      switch (part.type) {
        case 'text-delta': channel.send({ type: 'text', delta: (part as { text: string }).text }); break;
        case 'tool-call': {
          const name = (part as { toolName: string }).toolName;
          const args = (part as { input: Record<string, unknown> }).input;
          const spec = specByName.get(name);
          const decision = spec ? policy(ctx, spec, args) : null;
          if (!spec || !decision || decision.allow === false) {
            channel.send({ type: 'tool_result', tool: name, result: { ok: false, denied: true } });
          } else if (spec.risk === 'write' && decision.confirm === false) {
            // Auto-approved write: run inline server-side (no card), then re-drive to narrate.
            channel.send({ type: 'tool_call', tool: name, args });
            for (const m of (await result.response).messages) {
              appendMessage(ctx.db, ctx.conversationId, m as ModelMessage, consumerId);
            }
            const out = await executeWriteInline(ctx, spec, name, args);
            channel.send({ type: 'tool_result', tool: name, result: out });
            // Metered in the autoResume block below, AFTER the stream drains — the 'finish' part
            // that populates `usage` hasn't arrived yet when we break here.
            autoResume = true;
          } else {
            channel.send({ type: 'tool_call', tool: name, args });
          }
          break;
        }
        case 'tool-result': channel.send({ type: 'tool_result', tool: (part as { toolName: string }).toolName, result: (part as { output: unknown }).output }); break;
        case 'finish': {
          const u = (part as { totalUsage?: { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number } }).totalUsage ?? {};
          // inputTokens is the TOTAL (includes cache reads); cachedInputTokens is the cache-read
          // portion, billed at 10% by recordUsage.
          usage = { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cached: u.cachedInputTokens ?? 0 };
          break;
        }
        case 'error': channel.send({ type: 'error', message: String((part as { error: unknown }).error) }); break;
      }
      if (autoResume) break;
    }
    if (autoResume) {
      // We broke out before 'finish' — read the REAL totals from the drained stream, so the
      // consumer cap and the spend log see this invocation's tokens (they used to get zeros).
      usage = await usageFromResult(result);
      addUsage(ctx.db, consumerId, usage.input + usage.output);
      recordUsage(ctx.db, { model: loadAiRefs(ctx.db).consumerModel ?? 'unknown', input: usage.input, output: usage.output, cached: usage.cached });
      await driveConsumerLoop(ctx, channel, consumerId, roleId, signal);
      return;
    }
    const resp = await result.response;
    for (const m of resp.messages) appendMessage(ctx.db, ctx.conversationId, m as ModelMessage, consumerId);
    addUsage(ctx.db, consumerId, usage.input + usage.output); // closes B's cap loop
    recordUsage(ctx.db, { model: loadAiRefs(ctx.db).consumerModel ?? 'unknown', input: usage.input, output: usage.output, cached: usage.cached });
    channel.send({ type: 'done', usage: { ...usage, total: usage.input + usage.output } });
  } catch (e) {
    channel.send({ type: 'error', message: (e as Error).message });
  }
}
