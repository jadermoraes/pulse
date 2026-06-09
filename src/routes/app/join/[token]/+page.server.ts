import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { getInvite } from '$lib/server/identity/invites';
import { getRole } from '$lib/server/identity/roles';
import { getShowcaseTitles, type ShowcaseTitle } from '$lib/server/consumer/showcase';

// The join page is pre-session (CONSUMER_PUBLIC). We expose the invite's role token-cap (so the
// "Your plan" beat can show a friendly usage line, only when the role is capped) plus real
// title cards for the "available"/"request" beats — gated behind a VALID invite so the on-server
// list isn't leaked to anyone hitting the URL. Posters are public TMDB URLs only; no library proxy.
export const load: PageServerLoad = async ({ params }) => {
  const db = getDb();
  const inv = getInvite(db, params.token);
  let tokenCap: number | null = null;
  let planName: string | null = null;
  let available: ShowcaseTitle[] = [];
  let request: ShowcaseTitle[] = [];
  if (inv && !inv.acceptedAt && inv.expiresAt >= Date.now()) {
    const role = getRole(db, inv.roleId);
    if (role) {
      tokenCap = role.monthlyTokenCap;
      planName = role.planName;
    }
    try {
      const titles = await getShowcaseTitles(db);
      available = titles.available;
      request = titles.request;
    } catch {
      /* seerr down ⇒ gradient-placeholder fallback in the UI */
    }
  }
  return { tokenCap, planName, available, request };
};
