import { createMCPClient } from '@ai-sdk/mcp';
import type { DB } from '../db';
import { getSetting, setSetting } from '../settings';
import { encryptSecret, decryptSecret } from '../crypto';
import { scrub } from './scrub';
import type { AgentContext, ToolSpec } from './types';

export interface McpServerConfig {
  name: string;                              // namespace + display
  transport: 'sse' | 'http';                 // stdio needs a custom transport — out of v1 scope
  url: string;
  headers?: Record<string, string>;          // encrypted at rest
  enabled: boolean;
}

const KEY = 'ai_mcp_servers';

// Stored shape: headers JSON is encrypted as one blob.
interface StoredServer extends Omit<McpServerConfig, 'headers'> { headersEnc: string | null; }

export function loadMcpServers(db: DB): McpServerConfig[] {
  const raw = getSetting(db, KEY);
  if (!raw) return [];
  let arr: StoredServer[];
  try { arr = JSON.parse(raw); } catch { return []; }
  return arr.map((s) => ({
    name: s.name, transport: s.transport, url: s.url, enabled: s.enabled,
    headers: s.headersEnc ? JSON.parse(decryptSecret(s.headersEnc)) : undefined
  }));
}

export function saveMcpServers(db: DB, servers: McpServerConfig[]): void {
  const stored: StoredServer[] = servers.map((s) => ({
    name: s.name, transport: s.transport, url: s.url, enabled: s.enabled,
    headersEnc: s.headers && Object.keys(s.headers).length ? encryptSecret(JSON.stringify(s.headers)) : null
  }));
  setSetting(db, KEY, JSON.stringify(stored));
}

// Tools known to be read-only get risk:'read'; everything else defaults to 'write' (confirm gate).
// Match only when the tool name STARTS WITH a read verb (e.g. "read_file", "list_dirs") —
// prefixed names like "web_search" or "filesystem_search" default to write.
const READ_ONLY = /^(read|list|get|fetch|lookup|query|find)_?/i;

export interface McpClientHandle { close(): Promise<void>; }

/**
 * Connect to all enabled MCP servers, discover their tools, and return ToolSpecs (namespaced
 * `mcp__<server>__<tool>`) plus the open clients (caller must close them) and connect warnings.
 * A failing server is skipped with a warning; never throws.
 */
export async function connectMcpTools(db: DB): Promise<{
  specs: ToolSpec[]; clients: McpClientHandle[]; warnings: string[];
}> {
  const servers = loadMcpServers(db).filter((s) => s.enabled);
  const specs: ToolSpec[] = [];
  const clients: McpClientHandle[] = [];
  const warnings: string[] = [];

  for (const server of servers) {
    try {
      const client = await createMCPClient({
        transport: { type: server.transport, url: server.url, headers: server.headers }
      });
      clients.push(client as McpClientHandle);
      const tools = await (client as any).tools();
      for (const [toolName, def] of Object.entries(tools as Record<string, any>)) {
        const name = `mcp__${server.name}__${toolName}`;
        const risk = READ_ONLY.test(toolName) ? 'read' as const : 'write' as const;
        // Capture loop variables for the closure
        const capturedDef = def;
        specs.push({
          name, risk, category: 'mcp',
          description: `[${server.name}] ${capturedDef.description ?? toolName}`,
          // The MCP client already produced an AI-SDK Schema for the tool's inputs; reuse it
          // verbatim so the model sees the tool's real parameters (not an empty object).
          inputSchema: capturedDef.inputSchema,
          async run(_ctx: AgentContext, args: Record<string, unknown>) {
            const out = await capturedDef.execute(args, { toolCallId: name, messages: [] });
            return scrub(out);
          },
          summarize(_ctx: AgentContext, args: Record<string, unknown>) {
            return `MCP ${server.name}.${toolName}(${JSON.stringify(scrub(args))})`;
          }
        });
      }
    } catch (e) {
      warnings.push(`MCP server "${server.name}" unavailable: ${(e as Error).message}`);
    }
  }
  return { specs, clients, warnings };
}
