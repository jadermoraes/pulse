// src/lib/server/identity/types.ts  (authoritative — created in Task 2)

/** The five operator-facing capability keys an allow-list is built from. */
export type Capability = 'discover' | 'request' | 'status' | 'watchlist' | 'message_admin';
export const CAPABILITIES: readonly Capability[] =
  ['discover', 'request', 'status', 'watchlist', 'message_admin'] as const;

export interface Role {
  id: number;
  name: string;
  allowList: Capability[];        // json array of capability keys
  monthlyTokenCap: number | null; // null = unlimited
  planName: string | null;        // named token tier ('Light' | 'Regular' | … | 'Custom'); null = unset
  autoApprove: boolean;
  seerrQuota: { movie?: number; tv?: number }; // {} = provider default
  isAdmin: boolean;
  editable: boolean;
  createdAt: number;
}

export type ConsumerStatus = 'pending' | 'active' | 'disabled';

export interface ConsumerUser {
  id: number;
  roleId: number;
  displayName: string;
  jellyfinUserId: string | null;
  jellyfinUsername: string | null; // real Jellyfin login name (persisted at provision time)
  seerrUserId: number | null;
  plexAccountId: string | null;   // B.2
  language: string;               // 'en' | 'pt-BR' | …
  capOverride: number | null;     // null = use role cap
  allowOverride: Capability[] | null; // null = use role allow-list
  status: ConsumerStatus;
  createdAt: number;
}

export interface Invite {
  id: number;
  token: string;
  roleId: number;
  createdBy: number;              // admin user id
  expiresAt: number;
  acceptedAt: number | null;
  acceptedConsumerId: number | null;
  createdAt: number;
}
