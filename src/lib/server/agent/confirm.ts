import { randomUUID } from 'node:crypto';

export interface PendingAction {
  id: string;
  conversationId: number;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
  /** The full AI-SDK ModelMessage[] up to (and including) the assistant tool-call, to resume from. */
  resumeMessages?: unknown[];
  createdAt: number;
  ttlMs: number;
}

const DEFAULT_TTL = 10 * 60 * 1000; // 10 minutes
const store = new Map<string, PendingAction>();

export function registerPending(p: {
  conversationId: number; tool: string; args: Record<string, unknown>;
  summary: string; resumeMessages?: unknown[]; ttlMs?: number;
}): string {
  const id = randomUUID();
  store.set(id, {
    id, conversationId: p.conversationId, tool: p.tool, args: p.args,
    summary: p.summary, resumeMessages: p.resumeMessages,
    createdAt: Date.now(), ttlMs: p.ttlMs ?? DEFAULT_TTL
  });
  return id;
}

export function getPending(id: string): PendingAction | undefined {
  const p = store.get(id);
  if (p && Date.now() - p.createdAt > p.ttlMs) { store.delete(id); return undefined; }
  return p;
}

/** Atomically take a pending action (single-use). */
export function resolvePending(id: string): PendingAction | undefined {
  const p = getPending(id);
  if (p) store.delete(id);
  return p;
}

export function expireStale(): void {
  const now = Date.now();
  for (const [id, p] of store) if (now - p.createdAt > p.ttlMs) store.delete(id);
}

export function __resetPending(): void { store.clear(); }
