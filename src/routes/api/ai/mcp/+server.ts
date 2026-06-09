import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { loadMcpServers, saveMcpServers, type McpServerConfig } from '$lib/server/agent/mcp';

// GET → servers WITHOUT header values (presence flag only).
export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const servers = loadMcpServers(getDb()).map((s) => ({
    name: s.name, transport: s.transport, url: s.url, enabled: s.enabled,
    hasHeaders: Boolean(s.headers && Object.keys(s.headers).length)
  }));
  return json({ servers });
};

// POST → replace the full server list. Body: { servers: McpServerConfig[] }.
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  let body: { servers?: McpServerConfig[] };
  try { body = await request.json(); } catch { throw error(400, 'Invalid JSON body'); }
  if (!Array.isArray(body.servers)) throw error(400, 'servers array required');
  for (const s of body.servers) {
    if (!s.name || !s.url || (s.transport !== 'sse' && s.transport !== 'http')) {
      throw error(400, 'each server needs name, url, transport (sse|http)');
    }
  }
  saveMcpServers(getDb(), body.servers);
  return json({ ok: true });
};
