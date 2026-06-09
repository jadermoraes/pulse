// Client-safe consumer token-plan math.
//
// SvelteKit blocks importing `$lib/server/*` into browser code, but the plan→cap
// mapping and "~N chats left" estimate are needed in both the role editor (admin
// browser) and My-Account (consumer browser). So the pure values + functions live
// here (outside `$lib/server`); `$lib/server/consumer/types` and `…/plan` re-export
// them so server modules keep a single source of truth.

/** Named token tiers → monthly cap (null = unlimited). 'Custom' = an arbitrary number. */
export const TOKEN_PLANS = {
  Light: 250_000,
  Regular: 1_000_000,
  Power: 5_000_000,
  Unlimited: null
} as const;
export type PlanName = keyof typeof TOKEN_PLANS | 'Custom';

/** Average tokens per consumer chat turn — the basis for "~N chats left". Recalibrated post-launch. */
export const AVG_TOKENS_PER_CHAT = 12_000;

/** Resolve a plan name to its monthly token cap (null = unlimited). 'Custom' uses the operator-typed number. */
export function planToCap(plan: PlanName, custom?: number): number | null {
  if (plan === 'Custom') return custom != null ? custom : null;
  return TOKEN_PLANS[plan];
}

/** Map a stored cap back to the matching named plan, or 'Custom' for an arbitrary value. */
export function capToPlan(cap: number | null): PlanName {
  if (cap === null) return 'Unlimited';
  for (const [name, value] of Object.entries(TOKEN_PLANS) as [PlanName, number | null][])
    if (value === cap) return name;
  return 'Custom';
}

/** "~N chats left" — floor of remaining budget / AVG_TOKENS_PER_CHAT. Unlimited cap ⇒ Infinity. */
export function chatsLeft(cap: number | null, monthToDate: number): number {
  if (cap === null) return Infinity;
  return Math.max(0, Math.floor((cap - monthToDate) / AVG_TOKENS_PER_CHAT));
}
