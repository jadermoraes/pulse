import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { jsonSchema, asSchema } from 'ai';
import { openDb, migrate, type DB } from '../db';
import { _resetKeyCache } from '../crypto';
import { saveMcpServers, loadMcpServers, connectMcpTools, type McpServerConfig } from './mcp';
import { toAiTools } from './tools';
import type { AgentContext } from './types';

// Mock the MCP client factory.
// read_file carries a real input schema with a `path` parameter so we can assert it survives
// through ToolSpec → toAiTools (regression: MCP read tools were called with empty args).
const fsReadJsonSchema = {
  type: 'object',
  properties: { path: { type: 'string', description: 'file to read' } },
  required: ['path']
};
const fakeTools = {
  web_search: { description: 'search the web', inputSchema: { type: 'object', properties: {} }, execute: vi.fn() },
  read_file: { description: 'read a file', inputSchema: jsonSchema(fsReadJsonSchema), execute: vi.fn() }
};
vi.mock('@ai-sdk/mcp', () => ({
  createMCPClient: vi.fn(async (cfg: any) => {
    if (cfg.__fail) throw new Error('connect failed');
    return { tools: async () => fakeTools, close: async () => {} };
  })
}));

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); _resetKeyCache(); });
afterEach(() => vi.restoreAllMocks());

describe('mcp config', () => {
  it('saves servers with headers encrypted and reloads them decrypted', () => {
    const servers: McpServerConfig[] = [{
      name: 'web', transport: 'http', url: 'http://mcp:9000',
      headers: { Authorization: 'Bearer SECRET' }, enabled: true
    }];
    saveMcpServers(db, servers);
    const raw = db.prepare("select value from settings where key='ai_mcp_servers'").get() as any;
    expect(raw.value).not.toContain('Bearer SECRET');     // encrypted at rest
    const loaded = loadMcpServers(db);
    expect(loaded[0].headers!.Authorization).toBe('Bearer SECRET');
  });
});

describe('connectMcpTools', () => {
  it('merges tools from enabled servers, namespaced, default risk write', async () => {
    saveMcpServers(db, [{ name: 'web', transport: 'http', url: 'http://mcp:9000', enabled: true }]);
    const { specs, clients, warnings } = await connectMcpTools(db);
    const names = specs.map((s) => s.name);
    expect(names).toContain('mcp__web__web_search');
    expect(specs.find((s) => s.name === 'mcp__web__web_search')!.risk).toBe('write');
    expect(warnings).toHaveLength(0);
    for (const c of clients) await c.close();
  });

  it('degrades gracefully when a server fails to connect (warning, others continue)', async () => {
    const mcp = await import('@ai-sdk/mcp');
    (mcp.createMCPClient as any).mockImplementationOnce(async () => { throw new Error('connect failed'); });
    saveMcpServers(db, [{ name: 'down', transport: 'http', url: 'http://x', enabled: true }]);
    const { specs, warnings } = await connectMcpTools(db);
    expect(specs).toHaveLength(0);
    expect(warnings[0]).toContain('down');
  });

  it('skips disabled servers', async () => {
    saveMcpServers(db, [{ name: 'off', transport: 'http', url: 'http://x', enabled: false }]);
    const { specs } = await connectMcpTools(db);
    expect(specs).toHaveLength(0);
  });

  it('threads the MCP tool input schema through so read tools expose their params (not {})', async () => {
    saveMcpServers(db, [{ name: 'web', transport: 'http', url: 'http://mcp:9000', enabled: true }]);
    const { specs, clients } = await connectMcpTools(db);

    // read_file is a READ tool and must carry its own input schema on the spec.
    const readSpec = specs.find((s) => s.name === 'mcp__web__read_file')!;
    expect(readSpec.risk).toBe('read');
    expect(readSpec.inputSchema).toBeDefined();

    // After conversion the AI tool's inputSchema must still describe the `path` param,
    // not an empty object (the bug: SDK strips all props → execute({})).
    const ctx = { db, user: { id: 1, email: 'a@b.com' }, channel: 'web', conversationId: 1 } as AgentContext;
    const aiTools = toAiTools(ctx, specs);
    const js = asSchema((aiTools['mcp__web__read_file'] as any).inputSchema).jsonSchema as any;
    expect(js.properties?.path).toBeDefined();
    expect(Object.keys(js.properties ?? {})).toContain('path');

    for (const c of clients) await c.close();
  });
});
