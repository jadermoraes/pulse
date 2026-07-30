import { streamText, stepCountIs } from 'ai';
import type { ModelMessage, SystemModelMessage } from 'ai';
import type { DB } from '../db';
import { getModel, loadAiRefs } from './provider';
import { recordUsage } from './cost';
import { checkGuards } from './cost-guard';
import { buildToolSpecs, toAiTools } from './tools';
import { connectMcpTools } from './mcp';
import { policy } from './policy';
import { registerPending, resolvePending } from './confirm';
import { recordAction } from './audit';
import { recordEvent } from './events';
import { notifyAdmins } from '../notify';
import { CACHE_OPTS, withHistoryCacheMarker } from './cache';
import { truncateToolResult } from './truncate';
import { usageFromResult } from './usage';
import type { AgentContext, ToolSpec } from './types';
import type { Channel } from './channel';

const MAX_STEPS = 8;

/**
 * The system prompt as a cache-marked system message so the stable prefix (system prompt + tool
 * schemas) is cached. The conversation HISTORY gets its own breakpoint via withHistoryCacheMarker
 * at send time — without it, the history (which can be 100k+ tokens) is re-billed at full input
 * price on every call: every turn, every step of a multi-step turn, every retry.
 */
function systemMessage(): SystemModelMessage {
  return { role: 'system', content: systemPrompt(), providerOptions: CACHE_OPTS };
}

function systemPrompt(): string {
  return [
    'You are Pulse Assistant, the embedded admin agent for a self-hosted homelab dashboard.',
    'You can read live state (media servers, download clients, request manager, Docker, host metrics,',
    'and the event feed) and perform write actions (approve requests, re-search, remove downloads,',
    'restart/stop containers).',
    '',
    'Your homelab stack (route requests to the RIGHT service):',
    '- MOVIES are managed by Radarr; TV SERIES by Sonarr. Never conflate them — Spider-Noir is a TV',
    '  series, so it lives in Sonarr, not Radarr. Check the mediaType before acting.',
    '- Requests are placed through Seerr (jellyseerr). A title is ONE entry in TMDB/Seerr — there is',
    '  no separate "colored" vs "black & white" (or other edition) entry. You CANNOT request the same',
    '  title twice, and you cannot fetch a *specific* edition/cut through Seerr.',
    '- Media plays from Jellyfin/Plex; downloads run in qBittorrent (behind the VPN/gluetun).',
    '- Your CURRENT write tools for the *arr apps are limited to: re-searching or removing an item',
    '  that is ALREADY in the radarr/sonarr queue, and approving/declining/requesting via Seerr.',
    '  You do NOT have a tool to search for or pick a specific alternate RELEASE (e.g. a particular',
    '  colour cut) of a title. If the user asks for something your tools cannot do, say so plainly in',
    '  ONE clear reply and offer the real options — do not pretend, and do not keep re-explaining.',
    '',
    'Full control via the generic API tools:',
    '- You have apiRead / apiWrite (any configured service\'s REST API) and dockerApi / dockerWrite',
    '  (Docker Engine). Use listConnections for connection ids. Prefer the curated tools (getWidget,',
    '  searchMedia, getServerStats, …) when they fit; use the generic API tools for everything they',
    '  do not cover — add a series (POST sonarr /api/v3/series), trigger a search (POST',
    '  /api/v3/command {name:"SeriesSearch", seriesId}), grab a release, add a torrent, start/stop a',
    '  Proxmox VM, etc.',
    '- Base paths: radarr/sonarr /api/v3, seerr /api/v1, qbittorrent /api/v2, proxmox /api2/json,',
    '  tautulli /api/v2 with cmd=. Read the API first (apiRead) when you are unsure of the exact body.',
    '- qBittorrent: its /api/v2 is FORM-based — pass body as a plain object of fields; the server',
    '  form-encodes it. Add a torrent: POST /api/v2/torrents/add { urls, savepath?, category? }.',
    '- Sonarr/Radarr releases: to SEE/LIST the available releases for a title, apiRead GET',
    '  /api/v3/release?seriesId=<id> (Sonarr; add &seasonNumber=&episodeId= to narrow) or',
    '  /api/v3/release?movieId=<id> (Radarr) — this returns the real release list (quality, size,',
    '  seeders, title). To GRAB one, POST it back to /api/v3/release { guid, indexerId } (exact',
    '  values from the chosen release entry). NOTE: POST /api/v3/command {name:"SeriesSearch"} only',
    '  TRIGGERS a background search — it does NOT return a list; use apiRead /api/v3/release to show options.',
    '- There is no container shell/exec — work through these APIs only.',
    '- apiWrite/dockerWrite are WRITES: always pass a clear `summary` of the real effect (the admin',
    '  approves on it). You never have secrets; the server injects them.',
    '',
    'Rules:',
    '- DO NOT REPEAT YOURSELF. If you have already explained or stated something earlier in THIS',
    '  conversation, never say it again. Each reply must add NEW value: take a concrete action, give',
    '  new information from a tool, or ask one clarifying question. Re-sending a previous answer',
    '  (even reworded) is a failure — if you have nothing new, ask what specifically they want next.',
    '- ACT, never just narrate. If you intend to use a tool, CALL IT in this same turn. NEVER reply',
    '  with only an intention like "Let me check…" or "Let me trigger a re-search right now" without',
    '  the matching tool call — a message that announces an action but performs none is a failure.',
    '- Use the read tools to get FACTS before answering. Do not speculate ("likely", "probably",',
    '  "typically") when a tool can tell you — e.g. to know a title\'s version/quality, read it from',
    '  radarr/sonarr/jellyfin via getWidget/getMediaDetail rather than guessing from the genre.',
    '- ANSWER the user\'s actual question. If they ask something (e.g. "will this remove it and stop my',
    '  stream?"), answer it directly from facts; do NOT respond by performing an unrelated write',
    '  action. Only perform a write the user has explicitly asked for.',
    '- To request a title (or answer questions about a specific movie/show), FIRST call `searchMedia`',
    '  to get the exact `tmdbId` and `mediaType`. NEVER invent, guess, or recall a tmdbId from memory —',
    '  always use the tmdbId returned by `searchMedia`. Then call the request action with that exact',
    '  tmdbId + mediaType.',
    '- Audio/language for a request: if the user asks for Brazilian Portuguese / PT-BR / dublado,',
    '  pass params.audio:"ptbr" to the request action so it targets the PT-BR quality profile;',
    '  otherwise omit it (seerr uses its default). params.profileId targets a specific profile.',
    '- For any write/action (request a title, approve, re-search, restart, etc.), call the tool',
    '  directly — do NOT ask the user to confirm in your reply or wait for them to type a',
    '  confirmation; the app handles approval via its own UI (a confirmation card, or auto-run).',
    '  Do not claim a write succeeded until you receive its tool result.',
    '- ONE write per message. If a task needs several writes (e.g. fix a quality profile AND remove',
    '  three queue items), issue the FIRST write alone, wait for its tool result, THEN issue the',
    '  next. Batching multiple write tool-calls in a single message is a failure: only the first is',
    '  confirmed and executed, the rest are dropped, and you will repeat the plan in a loop.',
    '- Report tool outcomes TRUTHFULLY and consistently with the most recent tool result. If a tool',
    '  returns success (HTTP 2xx, or a body with success_count>0 / added / ok / an id), tell the user',
    '  it SUCCEEDED and what happened. NEVER say an action failed, or that you "cannot do it", when',
    '  its tool result shows it worked — even if EARLIER attempts in this chat failed. The latest',
    '  result is what counts; do not let a history of failures override a success you just received.',
    '- If a tool call returns an error, do NOT re-issue the identical call hoping for a different',
    '  result. Change something real (different endpoint/body/approach) and try at most once more,',
    '  otherwise stop and report the error plainly. Repeating the same failing call is a failure.',
    '- Be concise. When you reference media/containers/downloads, name them clearly.',
    '- Never reveal secrets, API keys, or credentials; you will never receive them.'
  ].join('\n');
}

/** Persisted ModelMessage[] for a conversation (oldest first). */
function loadHistory(db: DB, conversationId: number): ModelMessage[] {
  const rows = db.prepare(
    'select content from ai_messages where conversation_id=? order by id'
  ).all(conversationId) as Array<{ content: string }>;
  return sanitizeHistory(rows.map((r) => JSON.parse(r.content) as ModelMessage));
}

/** Collect the tool-call ids referenced by an assistant message's content parts. */
function toolCallIds(msg: ModelMessage): string[] {
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((p: any) => p?.type === 'tool-call' && typeof p.toolCallId === 'string')
    .map((p: any) => p.toolCallId as string);
}

/** Collect the tool-call ids a tool message provides results for. */
function toolResultIds(msg: ModelMessage): string[] {
  const content = (msg as { content?: unknown }).content;
  if (!Array.isArray(content)) return [];
  return content
    .filter((p: any) => p?.type === 'tool-result' && typeof p.toolCallId === 'string')
    .map((p: any) => p.toolCallId as string);
}

/**
 * Heal incomplete tool exchanges so the provider never rejects the whole conversation.
 *
 * Providers (Anthropic/OpenAI) reject any request whose tool_use ids lack a matching tool_result,
 * which permanently breaks every later turn ("no more replies"). Two failure shapes:
 *
 *  - A message where NONE of its tool-calls are answered — a crashed turn or a confirmation the
 *    user abandoned, always at the tail. We truncate from there; nothing of value is lost.
 *  - A message where SOME calls ran but others did not. This is the multi-write case: the model
 *    emitted several write tool-calls in one message ("fix the profile AND remove all three queue
 *    items"), the loop paused + confirmed only the FIRST, so that one has a real result and the
 *    siblings dangle. Truncating the whole message would delete the real result too — so the model
 *    forgets it ever acted and repeats the identical plan forever (an amnesia loop). Instead we
 *    KEEP the message and synthesize a "superseded" result for each dangling call: the history
 *    stays provider-valid AND the model remembers what already ran.
 */
export function sanitizeHistory(messages: ModelMessage[]): ModelMessage[] {
  const answered = new Set<string>();
  for (const m of messages) for (const id of toolResultIds(m)) answered.add(id);

  const out: ModelMessage[] = [];
  for (const m of messages) {
    const calls = toolCallIds(m);
    if (calls.length) {
      const answeredHere = calls.filter((id) => answered.has(id));
      if (answeredHere.length === 0) break; // fully-unanswered tail: truncate from here onward
      if (answeredHere.length < calls.length) {
        // Partially answered: keep the message, then backfill the dangling calls so a real
        // result already in history (a write that DID run) is never truncated away with it.
        out.push(m);
        for (const id of calls) if (!answered.has(id)) out.push(supersededToolResult(m, id));
        continue;
      }
    }
    out.push(m);
  }
  return out;
}

/**
 * A placeholder tool-result for a queued tool-call that never executed — its sibling write paused
 * the turn and only that one ran. Marks the call superseded (not a faked success) so the model
 * knows to re-issue it if still needed, and keeps every tool_use id answered for the provider.
 */
function supersededToolResult(assistant: ModelMessage, toolCallId: string): ModelMessage {
  const content = (assistant as { content?: unknown }).content;
  const call = Array.isArray(content)
    ? (content as any[]).find((p) => p?.type === 'tool-call' && p.toolCallId === toolCallId)
    : null;
  const toolName = (call as { toolName?: string } | null)?.toolName ?? 'unknown';
  return {
    role: 'tool',
    content: [{
      type: 'tool-result', toolCallId, toolName,
      output: { type: 'json', value: {
        ok: false, superseded: true,
        message: 'Not executed: this tool-call was queued alongside another write that paused the ' +
          'turn, so it never ran. Re-issue it (one write per message) if it is still needed.'
      } }
    }]
  } as unknown as ModelMessage;
}

function appendMessage(db: DB, conversationId: number, msg: ModelMessage, tokens = 0): void {
  db.prepare('insert into ai_messages(conversation_id,role,content,tokens,ts) values (?,?,?,?,?)')
    .run(conversationId, (msg as any).role ?? 'assistant', JSON.stringify(msg), tokens, Date.now());
}

/**
 * Run one user turn. Streams events to the channel. If the model calls a WRITE tool,
 * registers a pending action + emits confirmation_required and STOPS (the loop resumes
 * from /api/agent/confirm via resumeAgentTurn).
 */
export async function runAgentTurn(
  ctx: AgentContext, channel: Channel, userMessage: string, signal?: AbortSignal
): Promise<void> {
  appendMessage(ctx.db, ctx.conversationId, { role: 'user', content: userMessage } as ModelMessage);
  await driveLoop(ctx, channel, signal);
}

/** Resume the loop after a confirmation, with the write tool's result already appended. */
export async function resumeAgentTurn(ctx: AgentContext, channel: Channel, signal?: AbortSignal): Promise<void> {
  await driveLoop(ctx, channel, signal);
}

async function driveLoop(ctx: AgentContext, channel: Channel, signal?: AbortSignal): Promise<void> {
  // Test hook: a deterministic, hermetic driver (no real LLM/network) for e2e.
  // Production code path is untouched at runtime unless PULSE_AGENT_FAKE=1.
  if (process.env.PULSE_AGENT_FAKE === '1') {
    const { fakeDrive } = await import('./fake');
    await fakeDrive(ctx, channel);
    return;
  }

  const model = getModel(ctx.db);
  if (!model) { channel.send({ type: 'error', message: 'No AI provider configured' }); return; }

  const specs = await buildToolSpecs(ctx);

  // Connect MCP servers and merge their tools (graceful degrade — warnings surface as text).
  const mcp = await connectMcpTools(ctx.db);
  for (const w of mcp.warnings) channel.send({ type: 'text', delta: `\n_⚠ ${w}_\n` });
  specs.push(...mcp.specs);

  const specByName = new Map<string, ToolSpec>(specs.map((s) => [s.name, s]));
  const aiTools = toAiTools(ctx, specs);
  const messages = loadHistory(ctx.db, ctx.conversationId);

  let usage = { input: 0, output: 0, cached: 0 };
  // Per-turn cost (USD), accumulated across each recordUsage call this drive. Task 3 reads this.
  let turnCost = 0;
  // Per-turn step count (tool-call parts), read by checkGuards for the per-turn-steps guardrail.
  let steps = 0;
  // Dedupe guard: the 'error' stream part and the catch can both fire in a failing turn.
  // We record at most ONE turn_error audit row per driveLoop call.
  let turnErrorRecorded = false;
  /** Best-effort: record the error once; never let recording itself propagate. */
  function recordTurnError(message: string): void {
    if (turnErrorRecorded) return;
    turnErrorRecorded = true;
    try { recordAction(ctx, { tool: 'turn_error', args: {}, result: { message }, confirmed: false }); }
    catch { /* recording is best-effort; never mask the real error */ }
  }
  /** API/credit/quota/rate-limit class error → alert the admin (the chat is effectively down). */
  function alertProviderError(message: string): void {
    if (!/credit balance|api key|quota|rate.?limit|insufficient|AI_APICallError|overloaded/i.test(message)) return;
    try {
      const id = recordEvent(ctx.db, {
        source: 'ai', type: 'ai_provider_error', severity: 'crit',
        title: 'AI provider error', body: message, dedupeKey: 'ai_provider_error'
      });
      if (id) void notifyAdmins(ctx.db, { title: 'AI provider error', body: message }).catch(() => {});
    } catch { /* best-effort */ }
  }

  try {
    const result = streamText({
      model,
      system: systemMessage(),
      // History cache breakpoint (send-time only, never persisted): follow-up turns re-read
      // the whole conversation at ~10% of the input rate instead of full price.
      messages: withHistoryCacheMarker(messages),
      tools: aiTools,
      stopWhen: stepCountIs(MAX_STEPS),
      abortSignal: signal
    });

    let paused = false;
    let autoResume = false;
    for await (const part of result.fullStream) {
      // Client disconnected mid-turn: stop draining the LLM stream and bail out.
      if (signal?.aborted) return;
      switch (part.type) {
        case 'text-delta':
          channel.send({ type: 'text', delta: (part as any).text });
          break;
        case 'tool-call': {
          steps++;
          const name = (part as any).toolName as string;
          const args = (part as any).input as Record<string, unknown>;
          const spec = specByName.get(name);
          channel.send({ type: 'tool_call', tool: name, args });
          // A WRITE tool (no execute) reaches us as a tool-call with finishReason 'tool-calls'.
          const decision = spec ? policy(ctx, spec, args) : null;
          if (spec && decision && decision.allow && decision.confirm) {
            const summary = spec.summarize?.(ctx, args) ?? `Run ${name}`;
            // Persist the assistant tool-call message so the resume continues correctly.
            await result.response.then((resp) => {
              for (const m of resp.messages) appendMessage(ctx.db, ctx.conversationId, m as ModelMessage);
            });
            const pendingId = registerPending({
              conversationId: ctx.conversationId, tool: name, args, summary
            });
            channel.send({ type: 'confirmation_required', pendingId, tool: name, summary, args });
            paused = true;
          } else if (spec && spec.risk === 'write' && decision && decision.allow && !decision.confirm) {
            // Auto-approved write (role auto-approves): run it inline, server-side, NO card.
            await result.response.then((resp) => {
              for (const m of resp.messages) appendMessage(ctx.db, ctx.conversationId, m as ModelMessage);
            });
            const out = await executeWriteInline(ctx, spec, name, args);
            channel.send({ type: 'tool_result', tool: name, result: out });
            // Metered in the autoResume block below, AFTER the stream drains — the 'finish' part
            // that populates `usage` hasn't arrived yet when we break here.
            // Resume the model so it can narrate the result with the tool-result in history.
            autoResume = true;
            break;
          }
          break;
        }
        case 'tool-result':
          channel.send({ type: 'tool_result', tool: (part as any).toolName, result: (part as any).output });
          break;
        case 'finish': {
          const u = (part as any).totalUsage ?? {};
          // inputTokens is the TOTAL (includes cache reads); cachedInputTokens is the cache-read
          // portion, billed at 10% by recordUsage.
          usage = { input: u.inputTokens ?? 0, output: u.outputTokens ?? 0, cached: u.cachedInputTokens ?? 0 };
          break;
        }
        case 'error': {
          const msg = String((part as any).error);
          recordTurnError(msg);
          alertProviderError(msg);
          channel.send({ type: 'error', message: msg });
          break;
        }
      }
      if (paused || autoResume) break;
    }

    if (autoResume) {
      // We broke out of the loop before 'finish' — read the REAL totals from the drained stream,
      // otherwise this invocation's tokens are never billed against the spend guardrails.
      usage = await usageFromResult(result);
      turnCost += recordUsage(ctx.db, { model: loadAiRefs(ctx.db).adminModel ?? 'unknown', input: usage.input, output: usage.output, cached: usage.cached });
      // The auto-executed write's result is in history; re-drive so the model wraps up.
      await driveLoop(ctx, channel, signal);
      return;
    }
    if (paused) {
      usage = await usageFromResult(result); // same early-break: 'finish' never populated `usage`
      turnCost += recordUsage(ctx.db, { model: loadAiRefs(ctx.db).adminModel ?? 'unknown', input: usage.input, output: usage.output, cached: usage.cached });
      return; // turn yields to the user; no 'done'
    }

    // Normal completion: persist the assistant message(s) + meter + done.
    const resp = await result.response;
    for (const m of resp.messages) appendMessage(ctx.db, ctx.conversationId, m as ModelMessage);
    turnCost += recordUsage(ctx.db, { model: loadAiRefs(ctx.db).adminModel ?? 'unknown', input: usage.input, output: usage.output, cached: usage.cached });
    // Evaluate spend guardrails on true turn completion (best-effort; never throws).
    checkGuards(ctx.db, turnCost, steps);
    channel.send({ type: 'done', usage: { ...usage, total: usage.input + usage.output } });
  } catch (e) {
    const msg = (e as Error).message;
    recordTurnError(msg);
    alertProviderError(msg);
    channel.send({ type: 'error', message: msg });
  } finally {
    // Always close MCP clients regardless of outcome.
    for (const c of mcp.clients) { try { await c.close(); } catch { /* ignore */ } }
  }
}

export interface ConfirmOutcome { ok: boolean; result?: unknown; message?: string; }

/**
 * Append a tool-result message keyed to the conversation's latest assistant tool-call for
 * `toolName`, so streamText can resume the turn. Falls back to a synthetic id.
 */
function appendToolResult(ctx: AgentContext, toolName: string, result: unknown): void {
  const lastAssistant = ctx.db.prepare(
    "select content from ai_messages where conversation_id=? and role='assistant' order by id desc limit 1"
  ).get(ctx.conversationId) as { content: string } | undefined;
  let toolCallId = `${toolName}-${Date.now()}`;
  if (lastAssistant) {
    try {
      const parts = (JSON.parse(lastAssistant.content) as any).content;
      const call = Array.isArray(parts)
        ? parts.find((p: any) => p.type === 'tool-call' && p.toolName === toolName)
        : null;
      if (call?.toolCallId) toolCallId = call.toolCallId;
    } catch { /* fall back to synthetic id */ }
  }
  // Truncate before persisting: this message is re-sent on every later call of the conversation.
  const capped = truncateToolResult(result);
  const toolMessage: ModelMessage = {
    role: 'tool',
    content: [{ type: 'tool-result', toolCallId, toolName, output: { type: 'json', value: capped as any } }]
  } as unknown as ModelMessage;
  appendMessage(ctx.db, ctx.conversationId, toolMessage);
}

/**
 * Run an auto-approved write inline (the same effect path executeConfirmed uses): execute the
 * tool, record an audit row (confirmed=true), and append a tool-result message so the model can
 * be resumed to narrate the outcome. Returns the (scrubbed) result.
 */
export async function executeWriteInline(
  ctx: AgentContext, spec: ToolSpec, toolName: string, args: Record<string, unknown>
): Promise<unknown> {
  let result: unknown;
  let undoToken: ReturnType<NonNullable<ToolSpec['undo']>> | null = null;
  try {
    result = await spec.run(ctx, args);                  // the REAL mutation runs here
    undoToken = spec.undo?.(ctx, args, result) ?? null;
  } catch (e) {
    // The assistant tool-call was already persisted by the caller; we MUST still append a
    // matching tool-result or the conversation is poisoned for every later turn.
    result = { ok: false, error: `${toolName} failed: ${(e as Error).message}` };
  }
  recordAction(ctx, { tool: toolName, args, result, confirmed: true, undoToken });
  appendToolResult(ctx, toolName, result);
  return result;
}

/**
 * Execute (or decline) a pending write, audit it, and append a tool-result message so the
 * model can be resumed. Returns the (scrubbed) result; the caller then streams the resumed turn.
 */
export async function executeConfirmed(ctx: AgentContext, pendingId: string, approved: boolean): Promise<ConfirmOutcome> {
  const pending = resolvePending(pendingId);
  if (!pending) return { ok: false, message: 'Pending action expired or not found' };
  const builtinSpecs = await buildToolSpecs(ctx);
  // Also connect MCP tools so a confirmed MCP write can run.
  const mcp = await connectMcpTools(ctx.db).catch(() => ({ specs: [], clients: [], warnings: [] }));
  const specs = [...builtinSpecs, ...mcp.specs];
  const spec = specs.find((s) => s.name === pending.tool);
  // Ensure MCP clients are closed after use.
  const closeMcp = async () => {
    for (const c of mcp.clients) { try { await c.close(); } catch { /* ignore */ } }
  };

  let result: unknown;
  let undoToken = null as ReturnType<NonNullable<ToolSpec['undo']>> | null;
  if (!approved) {
    result = { ok: false, declined: true, message: 'User declined this action.' };
    recordAction(ctx, { tool: pending.tool, args: pending.args, result, confirmed: false });
  } else if (!spec) {
    result = { ok: false, message: `Tool ${pending.tool} is no longer available` };
    recordAction(ctx, { tool: pending.tool, args: pending.args, result, confirmed: true });
  } else {
    try {
      result = await spec.run(ctx, pending.args);        // the REAL mutation runs here
      undoToken = spec.undo?.(ctx, pending.args, result) ?? null;
    } catch (e) {
      // Append-a-result-no-matter-what: the assistant tool-call is already in history, so a
      // thrown write would otherwise leave it dangling and break all subsequent turns.
      result = { ok: false, error: `${pending.tool} failed: ${(e as Error).message}` };
    }
    recordAction(ctx, { tool: pending.tool, args: pending.args, result, confirmed: true, undoToken });
  }

  // Append a tool-result message keyed by the original tool call so streamText can resume.
  appendToolResult(ctx, pending.tool, result);
  await closeMcp();
  return { ok: true, result };
}
