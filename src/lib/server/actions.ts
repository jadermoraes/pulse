import type { DB } from './db';
import { getConnection } from './connections';
import { getIntegration } from './integrations';
import type { ActionResult, MediaDetail } from './integrations/types';

// Resolves a rich media-detail for the drawer. Returns:
//  - { ok: true, detail }            on success
//  - { ok: false, status: 404 }      if the integration has no `detail`
//  - { ok: false, status: 502, ... } if the upstream fetch threw
export async function resolveDetail(
  db: DB,
  connectionId: number,
  params: Record<string, unknown>
): Promise<{ ok: true; detail: MediaDetail } | { ok: false; status: number; message: string }> {
  const conn = getConnection(db, connectionId);
  if (!conn) return { ok: false, status: 404, message: 'Connection not found' };
  const integ = getIntegration(conn.type);
  if (!integ?.detail) return { ok: false, status: 404, message: `No detail for ${conn.type}` };
  try {
    const detail = await integ.detail(conn, params ?? {});
    return { ok: true, detail };
  } catch (e) {
    return { ok: false, status: 502, message: (e as Error).message };
  }
}

export async function resolveAction(
  db: DB,
  connectionId: number,
  action: string,
  params: Record<string, unknown>
): Promise<ActionResult> {
  const conn = getConnection(db, connectionId);
  if (!conn) return { ok: false, message: 'Connection not found' };
  const integ = getIntegration(conn.type);
  const handler = integ?.actions?.[action];
  // The actions map IS the allowlist — an action not present is rejected.
  if (!handler) return { ok: false, message: `Unknown action ${conn.type}.${action}` };
  try {
    return await handler.run(conn, params ?? {});
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
