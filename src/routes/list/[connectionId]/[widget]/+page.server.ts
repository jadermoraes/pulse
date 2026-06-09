import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { getConnection } from '$lib/server/connections';
import { listConfig } from '$lib/listconfig';

export const load: PageServerLoad = async ({ params, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const connectionId = Number(params.connectionId);
  if (!Number.isFinite(connectionId)) throw error(400, 'Bad connection id');

  // Host-level Docker containers list: connectionId 0, widget 'containers'.
  if (connectionId === 0 && params.widget === 'containers') {
    return { connectionId: 0, type: 'docker', widget: 'containers', title: 'Containers', grid: false };
  }

  const conn = getConnection(getDb(), connectionId);
  if (!conn) throw error(404, 'Connection not found');
  const cfg = listConfig(conn.type, params.widget);
  if (!cfg) throw error(404, 'No list view for this widget');
  // No secret, no data — only display metadata. Data is fetched client-side from /api/widgets.
  return {
    connectionId,
    type: conn.type,
    widget: params.widget,
    title: cfg.title,
    grid: cfg.grid
  };
};
