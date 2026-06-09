import type { AiConnection } from './ai-connections';

/**
 * Build the request URL + headers for a provider's models-list endpoint.
 * Shared by the models route (live list) and the connections route (key validation),
 * so the provider URL/header logic lives in exactly one place.
 */
export function modelsRequest(conn: AiConnection): { url: string; headers: Record<string, string> } {
  const key = conn.secret ?? '';
  switch (conn.provider) {
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/models',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
      };
    case 'openai':
      return {
        url: 'https://api.openai.com/v1/models',
        headers: { Authorization: `Bearer ${key}` }
      };
    case 'google':
    case 'openai-compatible': {
      const base = (conn.baseUrl ?? '').replace(/\/+$/, '');
      const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
      return { url: `${base}/v1/models`, headers };
    }
    default:
      return { url: '', headers: {} };
  }
}

/**
 * Validate a connection by checking the key can LIST models (no generation).
 * - HTTP 2xx → ok (key valid / endpoint reachable).
 * - 401/403 → invalid key.
 * - other non-2xx → provider HTTP error.
 * - network error / unreachable → could not reach provider.
 * Local/openai-compatible providers need no key — a reachable /v1/models 2xx is enough.
 */
export async function validateConnectionByModels(
  conn: AiConnection
): Promise<{ ok: boolean; error?: string }> {
  const { url, headers } = modelsRequest(conn);
  if (!url) return { ok: false, error: 'Could not reach provider' };
  try {
    const res = await fetch(url, { headers });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, error: 'Invalid API key' };
    return { ok: false, error: `Provider returned HTTP ${res.status}` };
  } catch {
    return { ok: false, error: 'Could not reach provider' };
  }
}
