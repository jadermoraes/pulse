/**
 * Client-side parser for the agent's SSE stream (`/api/agent/chat`, `/api/agent/confirm`).
 * The server writes `data: <json>\n\n` frames; this splits the byte stream on the blank-line
 * frame boundary and parses each `data:` payload into a typed AgentEvent.
 *
 * Mirrors the server's `AgentEvent` union (src/lib/server/agent/channel.ts) plus the
 * `meta` frame the chat endpoint emits first.
 */
export type AgentSseEvent =
  | { type: 'meta'; conversationId: number }
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; tool: string; args: unknown }
  | { type: 'tool_result'; tool: string; result: unknown }
  | { type: 'confirmation_required'; pendingId: string; tool: string; summary: string; args: unknown }
  | { type: 'error'; message: string }
  | { type: 'blocked'; reason: 'cap' }
  | { type: 'done'; usage: { input: number; output: number; total: number } };

/**
 * Split a chunk of accumulated SSE text into complete frames. Returns the parsed
 * events for every complete `\n\n`-terminated frame and the remaining (incomplete) buffer.
 * Pure + synchronous so it can be unit-tested without a real stream.
 */
export function parseSseChunk(buffer: string): { events: AgentSseEvent[]; rest: string } {
  const events: AgentSseEvent[] = [];
  let rest = buffer;
  let idx: number;
  while ((idx = rest.indexOf('\n\n')) >= 0) {
    const frame = rest.slice(0, idx).trim();
    rest = rest.slice(idx + 2);
    if (frame.startsWith('data:')) {
      const payload = frame.slice(5).trim();
      if (!payload) continue;
      try {
        events.push(JSON.parse(payload) as AgentSseEvent);
      } catch {
        /* skip malformed frame */
      }
    }
  }
  return { events, rest };
}

/**
 * Read a `fetch` Response body as an SSE stream, dispatching each parsed AgentEvent
 * to `onEvent`. Resolves when the stream closes.
 */
export async function streamSse(res: Response, onEvent: (e: AgentSseEvent) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const { events, rest } = parseSseChunk(buffer);
    buffer = rest;
    for (const e of events) onEvent(e);
  }
  // Flush any trailing complete frame left after the final chunk.
  buffer += decoder.decode();
  const { events } = parseSseChunk(buffer.endsWith('\n\n') ? buffer : buffer + '\n\n');
  for (const e of events) onEvent(e);
}
