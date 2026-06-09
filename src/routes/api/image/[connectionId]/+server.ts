import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getConnection } from '$lib/server/connections';
import { getIntegration } from '$lib/server/integrations/registry';

export const GET: RequestHandler = async ({ params, url, locals }) => {
  // Auth gate — must be first. Allow both admin sessions (locals.user) and consumer
  // PWA sessions (locals.consumer): this endpoint only proxies media poster images,
  // which viewers must be able to load on the /app discover surface.
  if (!locals.user && !locals.consumer) throw error(401, 'Unauthorized');

  const id = Number(params.connectionId);
  if (!Number.isFinite(id)) throw error(400, 'Bad connection id');

  const path = url.searchParams.get('path') ?? '';

  // SSRF-safe path validation:
  // - must start with /
  // - must NOT start with // (protocol-relative)
  // - must NOT contain :// (absolute URL scheme)
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) {
    throw error(400, 'Invalid path');
  }

  const conn = getConnection(getDb(), id);
  if (!conn) throw error(404, 'Connection not found');

  const integration = getIntegration(conn.type);
  if (!integration?.imageRequest) {
    throw error(404, 'No image proxy for this connection type');
  }

  // Delegate URL + header construction to the integration — the apikey/token
  // is embedded server-side here and NEVER appears in the browser-visible path.
  const { url: target, headers: upstreamHeaders } = integration.imageRequest(conn, path);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      headers: upstreamHeaders ?? {},
      signal: controller.signal
    });
  } catch {
    return new Response(null, { status: 404 });
  } finally {
    clearTimeout(timeout);
  }

  if (!upstream.ok) {
    return new Response(null, { status: 404 });
  }

  const contentType = upstream.headers.get('Content-Type') ?? 'application/octet-stream';

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Cache-Control': 'public, max-age=3600'
    }
  });
};
