import type { DB } from './server/db';
import { getConnection } from './server/connections';
import { getIntegration } from './server/integrations';
import type { WidgetResult } from './server/integrations';

export async function resolveWidget(db: DB, connectionId: number, widget: string): Promise<WidgetResult> {
  const conn = getConnection(db, connectionId);
  if (!conn) return { ok: false, error: 'Connection not found' };
  const integ = getIntegration(conn.type);
  const fn = integ?.widgets[widget];
  if (!fn) return { ok: false, error: `Unknown widget ${conn.type}.${widget}` };
  try { return await fn(conn); }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}
