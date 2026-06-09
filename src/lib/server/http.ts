// Shared JSON-over-HTTP helper for header-authenticated integrations
// (seerr, radarr, sonarr). Secrets travel in the X-Api-Key header, never the URL.
export function joinUrl(baseUrl: string, path: string, query: Record<string, string | number> = {}): string {
  const u = new URL(baseUrl.replace(/\/$/, '') + path);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, String(v));
  return u.toString();
}

export async function getJsonWithKey(url: string, apiKey: string | null): Promise<any> {
  const res = await fetch(url, {
    headers: { 'X-Api-Key': apiKey ?? '', Accept: 'application/json' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// POST/DELETE/PUT JSON with header auth. Secret travels only in X-Api-Key, never the URL.
// 2xx with no JSON body (e.g. 204) resolves to {}.
export async function sendJsonWithKey(
  url: string,
  method: 'POST' | 'DELETE' | 'PUT',
  apiKey: string | null,
  body?: unknown
): Promise<any> {
  const init: RequestInit = {
    method,
    headers: { 'X-Api-Key': apiKey ?? '', Accept: 'application/json', 'Content-Type': 'application/json' }
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  try { return await res.json(); } catch { return {}; }
}
