/**
 * Integration test for the role-driven policy seam over the real DB (no provider HTTP).
 * Exercises the capability allow-list + month-to-date cap gate + auto-approve confirm
 * decision exactly as the agent loop would, against shipped roles/consumers/usage code.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { openDb, migrate, type DB } from '../db';
import { createRole } from './roles';
import { createConsumer } from './consumers';
import { addUsage } from './usage';
import { policy } from '../agent/policy';
import type { AgentContext, ToolSpec } from '../agent/types';

const read: ToolSpec = { name: 'getWidget', risk: 'read', category: 'media', description: '', run: async () => ({}) };
const status: ToolSpec = { name: 'getEvents', risk: 'read', category: 'events', description: '', run: async () => ({}) };
const request: ToolSpec = { name: 'runAction', risk: 'write', category: 'requests', description: '', run: async () => ({}) };

let db: DB;
beforeEach(() => { db = openDb(':memory:'); migrate(db); });

function ctx(consumerId: number, roleId: number): AgentContext {
  return { db, user: { id: 0, email: '' }, channel: 'web', conversationId: 1, consumer: { id: consumerId, roleId } };
}

describe('policy integration (capped vs auto-approve)', () => {
  it('a capped consumer is BLOCKED from the AI write but discover/status reads still work', () => {
    const roleId = createRole(db, { name: 'Member', allowList: ['discover', 'request', 'status'], monthlyTokenCap: 1000, autoApprove: false, seerrQuota: {} });
    const cid = createConsumer(db, { roleId, displayName: 'A', language: 'en' });
    addUsage(db, cid, 1000); // at cap
    expect(policy(ctx(cid, roleId), request, {}).allow).toBe(false);   // write blocked at cap
    expect(policy(ctx(cid, roleId), read, {}).allow).toBe(true);       // discover read survives
    expect(policy(ctx(cid, roleId), status, {}).allow).toBe(true);     // status read survives
  });

  it('an auto_approve role yields a no-confirm request; a non-auto role yields confirm (seerr-pending)', () => {
    const auto = createRole(db, { name: 'Auto', allowList: ['request'], monthlyTokenCap: null, autoApprove: true, seerrQuota: {} });
    const manual = createRole(db, { name: 'Manual', allowList: ['request'], monthlyTokenCap: null, autoApprove: false, seerrQuota: {} });
    const ca = createConsumer(db, { roleId: auto, displayName: 'A', language: 'en' });
    const cm = createConsumer(db, { roleId: manual, displayName: 'M', language: 'en' });
    expect(policy(ctx(ca, auto), request, {})).toEqual({ allow: true, confirm: false });   // auto-submit
    expect(policy(ctx(cm, manual), request, {})).toEqual({ allow: true, confirm: true });   // pending confirm
  });

  it('usage accrues into the next request decision', () => {
    const roleId = createRole(db, { name: 'M', allowList: ['request'], monthlyTokenCap: 500, autoApprove: false, seerrQuota: {} });
    const cid = createConsumer(db, { roleId, displayName: 'A', language: 'en' });
    expect(policy(ctx(cid, roleId), request, {}).allow).toBe(true);
    addUsage(db, cid, 500);
    expect(policy(ctx(cid, roleId), request, {}).allow).toBe(false);
  });
});
