import type { AgentContext, ToolSpec, PolicyDecision } from './types';
import { getRole } from '../identity/roles';
import { getConsumer, effectiveAllowList } from '../identity/consumers';
import { isOverCap } from '../identity/usage';
import { toolAllowed } from '../identity/capabilities';

/**
 * The single policy seam every tool call passes through.
 * - Admin (no `ctx.consumer`, OR a consumer bound to the immutable admin role) → allow-all, confirm writes.
 * - Consumer → deny tools outside the effective allow-list; deny WRITES when month-to-date ≥ effective cap
 *   (cheap reads stay allowed at the cap); confirm writes unless the role auto-approves.
 * Signature and the agent loop are unchanged.
 */
export function policy(ctx: AgentContext, spec: ToolSpec, _args: Record<string, unknown>): PolicyDecision {
  if (!ctx.user && !ctx.consumer) return { allow: false, reason: 'Not authenticated' };

  // --- admin path (unchanged behaviour) ---
  if (!ctx.consumer) return { allow: true, confirm: spec.risk === 'write' };

  const role = getRole(ctx.db, ctx.consumer.roleId);
  if (!role) return { allow: false, reason: 'Unknown role' };
  if (role.isAdmin) return { allow: true, confirm: spec.risk === 'write' };

  const consumer = getConsumer(ctx.db, ctx.consumer.id);
  if (!consumer || consumer.status === 'disabled') return { allow: false, reason: 'Account disabled' };

  // Allow-list: the tool's governing capability must be granted.
  const allow = effectiveAllowList(consumer, role);
  if (!toolAllowed(spec.name, allow)) return { allow: false, reason: 'Capability not allowed for your role' };

  // Cap gate: writes (token-consuming AI actions) are blocked at/over the cap; cheap reads survive.
  if (spec.risk === 'write' && isOverCap(ctx.db, consumer, role)) {
    return { allow: false, reason: 'cap' };
  }

  // Writes confirm unless the role auto-approves (e.g. a request under an auto_approve role).
  return { allow: true, confirm: spec.risk === 'write' ? !role.autoApprove : false };
}
