import { describe, it, expect } from 'vitest';
import { policy } from './policy';
import type { AgentContext, ToolSpec } from './types';

const ctx: AgentContext = {
  db: {} as any, user: { id: 1, email: 'a@b.com' }, channel: 'web', conversationId: 1
};
const read: ToolSpec = { name: 'getWidget', risk: 'read', category: 'media', description: '', run: async () => ({}) };
const write: ToolSpec = { name: 'runAction', risk: 'write', category: 'media', description: '', run: async () => ({}) };

describe('policy (v1 admin)', () => {
  it('allows reads without confirmation', () => {
    expect(policy(ctx, read, {})).toEqual({ allow: true, confirm: false });
  });
  it('allows writes but requires confirmation', () => {
    expect(policy(ctx, write, {})).toEqual({ allow: true, confirm: true });
  });
  it('denies when there is no user (guards non-web channels in B/C)', () => {
    const anon = { ...ctx, user: null as any };
    const d = policy(anon, read, {});
    expect(d.allow).toBe(false);
  });
});

import { describe as dC, it as iC, expect as eC, beforeEach as bC } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { createRole, getAdminRole } from '../identity/roles';
import { createConsumer } from '../identity/consumers';
import { addUsage } from '../identity/usage';
import { policy as policyC } from './policy';

let dbC: DB;
const readDiscover: ToolSpec = { name: 'getWidget', risk: 'read', category: 'media', description: '', run: async () => ({}) };
const readStatus: ToolSpec = { name: 'getEvents', risk: 'read', category: 'events', description: '', run: async () => ({}) };
const writeRequest: ToolSpec = { name: 'runAction', risk: 'write', category: 'requests', description: '', run: async () => ({}) };
const adminTool: ToolSpec = { name: 'restartContainer', risk: 'write', category: 'system', description: '', run: async () => ({}) };

bC(() => { dbC = openDb(':memory:'); migrate(dbC); });

dC('policy (consumer, role-driven)', () => {
  function ctxFor(roleId: number, consumerId: number): AgentContext {
    return { db: dbC, user: { id: 0, email: '' }, channel: 'web', conversationId: 1, consumer: { id: consumerId, roleId } };
  }

  iC('admin path (no consumer) is still allow-all + confirm-writes', () => {
    const admin = getAdminRole(dbC)!;
    const ctx: AgentContext = { db: dbC, user: { id: 1, email: 'a@b' }, channel: 'web', conversationId: 1, consumer: { id: 0, roleId: admin.id } };
    eC(policyC(ctx, adminTool, {})).toEqual({ allow: true, confirm: true });
  });

  iC('plain admin (no consumer field) unchanged', () => {
    const ctx: AgentContext = { db: dbC, user: { id: 1, email: 'a@b' }, channel: 'web', conversationId: 1 };
    eC(policyC(ctx, adminTool, {})).toEqual({ allow: true, confirm: true });
    eC(policyC(ctx, readDiscover, {})).toEqual({ allow: true, confirm: false });
  });

  iC('consumer: allows a granted-capability read, denies an ungranted one', () => {
    const roleId = createRole(dbC, { name: 'M', allowList: ['discover'], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} });
    const cid = createConsumer(dbC, { roleId, displayName: 'A', language: 'en' });
    eC(policyC(ctxFor(roleId, cid), readDiscover, {}).allow).toBe(true);
    const denied = policyC(ctxFor(roleId, cid), readStatus, {});
    eC(denied.allow).toBe(false);
  });

  iC('consumer: ungoverned admin tool always denied', () => {
    const roleId = createRole(dbC, { name: 'M', allowList: ['discover', 'request', 'status', 'watchlist', 'message_admin'], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} });
    const cid = createConsumer(dbC, { roleId, displayName: 'A', language: 'en' });
    eC(policyC(ctxFor(roleId, cid), adminTool, {}).allow).toBe(false);
  });

  iC('consumer: request write needs confirm unless role.autoApprove', () => {
    const manual = createRole(dbC, { name: 'Man', allowList: ['request'], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} });
    const auto = createRole(dbC, { name: 'Auto', allowList: ['request'], monthlyTokenCap: null, autoApprove: true, seerrQuota: {} });
    const c1 = createConsumer(dbC, { roleId: manual, displayName: 'A', language: 'en' });
    const c2 = createConsumer(dbC, { roleId: auto, displayName: 'B', language: 'en' });
    eC(policyC(ctxFor(manual, c1), writeRequest, {})).toEqual({ allow: true, confirm: true });
    eC(policyC(ctxFor(auto, c2), writeRequest, {})).toEqual({ allow: true, confirm: false });
  });

  iC('consumer at cap: write denied, cheap read still allowed', () => {
    const roleId = createRole(dbC, { name: 'M', allowList: ['discover', 'request'], monthlyTokenCap: 100, autoApprove: false, seerrQuota: {} });
    const cid = createConsumer(dbC, { roleId, displayName: 'A', language: 'en' });
    addUsage(dbC, cid, 100);
    eC(policyC(ctxFor(roleId, cid), writeRequest, {}).allow).toBe(false);    // over cap
    eC(policyC(ctxFor(roleId, cid), readDiscover, {}).allow).toBe(true);     // cheap read survives
  });
});
