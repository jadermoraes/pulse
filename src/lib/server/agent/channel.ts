import type { ToolRisk } from './types';

export type AgentEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; tool: string; args: unknown }
  | { type: 'tool_result'; tool: string; result: unknown }
  | { type: 'confirmation_required'; pendingId: string; tool: string; summary: string; args: unknown }
  | { type: 'error'; message: string }
  | { type: 'blocked'; reason: 'cap' }
  | { type: 'done'; usage: { input: number; output: number; total: number } };

/** A channel receives agent events. v1: the web channel encodes them as SSE. C adds Telegram/Discord. */
export interface Channel { send(event: AgentEvent): void | Promise<void>; }

/**
 * SSE encoder used by /api/agent/chat. Writes `data: <json>\n\n` frames.
 * After the stream is closed (client disconnect or controller.close()), `desiredSize`
 * is null; `send` then no-ops so we never throw "Controller is already closed".
 */
export function sseChannel(controller: ReadableStreamDefaultController, encoder: TextEncoder): Channel {
  return {
    send(event: AgentEvent) {
      if (controller.desiredSize === null) return; // stream closed → drop the frame
      try {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      } catch {
        // Enqueue can still race a close; swallow rather than surface an unhandled error.
      }
    }
  };
}

// Exported so the risk type stays referenced (and B/C can branch on it).
export type { ToolRisk };
