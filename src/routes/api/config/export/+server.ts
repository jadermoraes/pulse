import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { listConnections } from '$lib/server/connections';
import { getSetting } from '$lib/server/settings';
import { stringify } from 'yaml';

const LAYOUT_KEY = 'dashboard_layout';

export const GET: RequestHandler = async ({ url, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');

  const includeSecrets = url.searchParams.get('secrets') === '1';
  const db = getDb();

  // Build connections list
  const connections = listConnections(db).map((c) => {
    const entry: Record<string, unknown> = {
      type: c.type,
      name: c.name,
      baseUrl: c.baseUrl,
      enabled: c.enabled,
      options: c.options
    };
    if (includeSecrets) {
      entry.secret = c.secret ?? null;
    }
    return entry;
  });

  // Build layout
  let layout: unknown = null;
  const layoutRaw = getSetting(db, LAYOUT_KEY);
  if (layoutRaw) {
    try {
      layout = JSON.parse(layoutRaw);
    } catch {
      layout = null;
    }
  }

  const config: Record<string, unknown> = {
    version: 1,
    connections,
    layout: layout ?? []
  };

  const yaml = stringify(config);

  return new Response(yaml, {
    status: 200,
    headers: {
      'Content-Type': 'text/yaml; charset=utf-8',
      'Content-Disposition': 'attachment; filename="pulse-config.yaml"'
    }
  });
};
