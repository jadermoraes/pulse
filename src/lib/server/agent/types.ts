// src/lib/server/agent/types.ts  (authoritative — created in Task 3)
import type { DB } from '../db';

/** Who is asking + the transport. v1: always the admin over the 'web' channel. */
export interface AgentContext {
  db: DB;
  user: { id: number; email: string };
  channel: 'web' | 'telegram';  // C adds 'discord'
  conversationId: number;
  /** Set when the turn is driven by a consumer (D/C). Absent ⇒ admin path. */
  consumer?: { id: number; roleId: number };
}

export type ToolRisk = 'read' | 'write';

/** A tool description used to build the AI-SDK toolset + drive policy/audit. */
export interface ToolSpec {
  name: string;              // 'getWidget', 'runAction', 'restartContainer', 'mcp__<server>__<tool>'
  description: string;
  risk: ToolRisk;
  category: string;          // 'media' | 'downloads' | 'requests' | 'system' | 'events' | 'mcp' | …
  /**
   * The tool's own input schema, used by toAiTools instead of the built-in schemaFor().
   * For MCP tools this is the AI-SDK Schema object the MCP client already produced, so the
   * model sees the real parameters (without it the SDK strips all props and calls with {}).
   */
  inputSchema?: unknown;
  /** The runtime executor (server-side). Read tools run inline; write tools run only after confirm. */
  run(ctx: AgentContext, args: Record<string, unknown>): Promise<unknown>;
  /** Short human summary of a pending write, shown on the confirmation card. */
  summarize?(ctx: AgentContext, args: Record<string, unknown>): string;
  /** Inverse action descriptor for undo, or null when not undoable. */
  undo?(ctx: AgentContext, args: Record<string, unknown>, result: unknown): UndoToken | null;
}

/** A reversible action: the undo runs the named tool with the given args. */
export interface UndoToken { tool: string; args: Record<string, unknown>; label: string; }

/** Policy decision for a single tool call (Task 4). */
export type PolicyDecision =
  | { allow: true; confirm: boolean }
  | { allow: false; reason: string };
