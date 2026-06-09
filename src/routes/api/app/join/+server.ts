import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getInvite, acceptInvite } from '$lib/server/identity/invites';
import { createConsumer, getConsumer, deleteConsumer } from '$lib/server/identity/consumers';
import { provisionConsumer, type ProvisionResult } from '$lib/server/provisioning/provision';
import { deleteJellyfinUser, jellyfinUsernameTaken } from '$lib/server/provisioning/jellyfin';
import { deleteSeerrUser } from '$lib/server/provisioning/seerr';
import { listConnections } from '$lib/server/connections';
import { loginConsumer } from '$lib/server/identity/consumer-auth';
import { loginAllowed, recordLoginFailure, recordLoginSuccess } from '$lib/server/ratelimit';
import { validateOnboarding, cleanText } from '$lib/consumer/validate';
import type { DB } from '$lib/server/db';

/**
 * Best-effort de-provisioning of the downstream Jellyfin + seerr accounts that a just-completed
 * provision created, used when onboarding fails AFTER provisioning (e.g. a race-loser whose
 * acceptInvite throws because another join already burned the invite). Cleanup failure is
 * swallowed so the original error still surfaces.
 */
async function cleanupProvisioned(db: DB, prov: ProvisionResult): Promise<void> {
  try {
    const jellyfinConn = listConnections(db).find((c) => c.type === 'jellyfin' && c.enabled);
    if (jellyfinConn) await deleteJellyfinUser(jellyfinConn, prov.jellyfinUserId);
  } catch (e) {
    console.error('[join] Jellyfin cleanup failed', e);
  }
  try {
    const seerrConn = listConnections(db).find((c) => c.type === 'seerr' && c.enabled);
    if (seerrConn) await deleteSeerrUser(seerrConn, prov.seerrUserId);
  } catch (e) {
    console.error('[join] seerr cleanup failed', e);
  }
}

export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
  const ip = getClientAddress();
  const gate = loginAllowed(ip);
  if (!gate.allowed) throw error(429, `Too many attempts. Retry in ${gate.retryAfterSec}s`);

  let b: any;
  try {
    b = await request.json();
  } catch {
    throw error(400, 'Invalid JSON body');
  }
  const { token, language, plexToken } = b ?? {};
  // Normalize the user-chosen fields exactly as we'll store/compare them, then validate
  // (authoritative — the client validates too, but never trust it).
  const displayName = cleanText(b?.displayName);
  const username = cleanText(b?.username);
  const password = typeof b?.password === 'string' ? b.password : '';
  if (!token) throw error(400, 'token required');
  const invalid = validateOnboarding({ displayName, username, password });
  if (invalid) throw error(400, invalid);

  const db = getDb();
  const inv = getInvite(db, token);
  if (!inv || inv.acceptedAt || inv.expiresAt < Date.now()) {
    recordLoginFailure(ip);
    throw error(400, 'Invalid or expired invite');
  }

  // Reject a username that already exists on Jellyfin UP FRONT — otherwise provisioning would
  // silently attach this invitee to the existing account (409 so the UI can prompt for another).
  const jellyfinConn = listConnections(db).find((c) => c.type === 'jellyfin' && c.enabled);
  if (jellyfinConn) {
    try {
      if (await jellyfinUsernameTaken(jellyfinConn, username))
        throw error(409, 'That username is already taken — please choose another.');
    } catch (e) {
      // A 409 is our own thrown SvelteKit error — rethrow it. Any other failure (Jellyfin
      // unreachable) shouldn't block onboarding; provisioning will surface a real error later.
      if ((e as { status?: number }).status === 409) throw e;
    }
  }

  // Create the consumer bound to the invite's role (the invite's roleId is authoritative —
  // acceptance can never escalate the role).
  const roleId = inv.roleId;
  const consumerId = createConsumer(db, { roleId, displayName, language: language ?? 'en' });
  let provisioned: ProvisionResult | null = null;
  try {
    // Provision FIRST. The invite is only burned once downstream provisioning succeeds, so a
    // failed onboard (provider down, etc.) leaves the invite reusable for a retry.
    const consumer = getConsumer(db, consumerId)!;
    // plexToken (optional, B.2) is best-effort inside provisionConsumer — a Plex/WatchState
    // failure surfaces a warning but never blocks the Jellyfin+seerr onboarding.
    provisioned = await provisionConsumer(db, consumer, {
      username, password, plexToken: typeof plexToken === 'string' ? plexToken : undefined
    });
    // Provisioning succeeded → now atomically mark the invite accepted (single-use; throws if raced).
    acceptInvite(db, token, consumerId);
  } catch (e) {
    // If provisioning already created downstream accounts (this includes the race-loser case where
    // acceptInvite throws because a concurrent join burned the invite), tear those down so we don't
    // orphan real Jellyfin/seerr accounts. On a genuine provision failure (provisioned == null) we
    // keep the invite reusable and only unwind the half-created Pulse record.
    if (provisioned) await cleanupProvisioned(db, provisioned);
    deleteConsumer(db, consumerId); // unwind the half-created record so the invite can be retried
    recordLoginFailure(ip);
    console.error('[join] onboarding failed', e);
    throw error(502, 'Onboarding failed — please contact your admin.');
  }

  // Auto-login: validate the brand-new Jellyfin creds → issue the consumer session.
  const userAgent = request.headers.get('user-agent') ?? undefined;
  const sid = await loginConsumer(db, username, password, { ip, userAgent });
  recordLoginSuccess(ip);
  cookies.set('pulse_app', sid, { path: '/', httpOnly: true, sameSite: 'lax', maxAge: 60 * 60 * 24 * 30 });
  return json({ ok: true }, { status: 201 });
};
