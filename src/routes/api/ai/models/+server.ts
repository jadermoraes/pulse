import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getAiConnection } from '$lib/server/agent/ai-connections';
import type { AiProvider } from '$lib/server/agent/provider';
import { modelsRequest } from '$lib/server/agent/ai-models';

export interface ModelEntry {
  id: string;
  recommended: boolean;
}

// Substring matchers for the small curated "recommended" set per provider.
const RECOMMENDED: Record<AiProvider, RegExp[]> = {
  anthropic: [/^claude-sonnet-4-/, /^claude-3-5-haiku-/],
  openai: [/^gpt-4o$/, /^gpt-4o-mini$/],
  google: [/^gemini-1\.5-flash$/, /^gemini-1\.5-pro$/],
  'openai-compatible': []
};

// Curated fallback lists used when the provider's models API is unreachable, so the UI
// always has sensible options.
const FALLBACK: Record<AiProvider, string[]> = {
  anthropic: ['claude-sonnet-4-20250514', 'claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest'],
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo'],
  google: ['gemini-1.5-flash', 'gemini-1.5-pro'],
  'openai-compatible': []
};

function isRecommended(provider: AiProvider, id: string): boolean {
  return RECOMMENDED[provider].some((re) => re.test(id));
}

function withRecommended(provider: AiProvider, ids: string[]): ModelEntry[] {
  return ids.map((id) => ({ id, recommended: isRecommended(provider, id) }));
}

function fallbackList(provider: AiProvider): ModelEntry[] {
  return withRecommended(provider, FALLBACK[provider]);
}

/** Normalize the various provider model-list payloads into a flat list of ids. */
function extractIds(body: any): string[] {
  if (Array.isArray(body?.data)) return body.data.map((m: any) => m.id).filter(Boolean); // OpenAI/Anthropic shape
  if (Array.isArray(body?.models)) return body.models.map((m: any) => m.id ?? m.name ?? m.model).filter(Boolean); // Ollama /api/tags
  return [];
}

// GET ?connectionId= → live model list for the connection's provider, with a curated
// fallback list when the provider API is unreachable. Never returns the key.
export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const idParam = url.searchParams.get('connectionId');
  if (!idParam) throw error(400, 'connectionId required');
  const id = Number(idParam);
  if (!Number.isFinite(id)) throw error(400, 'connectionId required');

  const db = getDb();
  const conn = getAiConnection(db, id);
  if (!conn) throw error(400, 'connection not found');

  const { url: apiUrl, headers } = modelsRequest(conn);
  if (!apiUrl) return json({ models: fallbackList(conn.provider), fallback: true });

  try {
    const res = await fetch(apiUrl, { headers });
    if (!res.ok) return json({ models: fallbackList(conn.provider), fallback: true });
    const ids = extractIds(await res.json());
    if (ids.length === 0) return json({ models: fallbackList(conn.provider), fallback: true });
    return json({ models: withRecommended(conn.provider, ids) });
  } catch {
    return json({ models: fallbackList(conn.provider), fallback: true });
  }
};
