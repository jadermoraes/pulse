import { createHmac } from 'node:crypto';
import { getKey } from '../crypto';

export function signCallback(action: 'approve' | 'deny', pendingId: string): string {
  const sig = createHmac('sha256', getKey()).update(`${action}:${pendingId}`).digest('hex').slice(0, 16);
  return `${action}:${pendingId}:${sig}`;
}

export function verifyCallback(data: string): { action: 'approve' | 'deny'; pendingId: string } | null {
  const [action, pendingId, sig] = data.split(':');
  if ((action !== 'approve' && action !== 'deny') || !pendingId || !sig) return null;
  const expected = createHmac('sha256', getKey()).update(`${action}:${pendingId}`).digest('hex').slice(0, 16);
  return sig === expected ? { action: action as 'approve' | 'deny', pendingId } : null;
}
