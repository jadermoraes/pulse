import type { LayoutServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { listConnections } from '$lib/server/connections';
import { normaliseLocale, LOCALE_COOKIE } from '$lib/i18n';

export const load: LayoutServerLoad = async ({ locals, cookies }) => ({
  user: locals.user,
  // Resolve the locale server-side from the cookie so SSR renders the correct
  // language and there is no en→pt flash on the client.
  locale: normaliseLocale(cookies.get(LOCALE_COOKIE)),
  connections: locals.user
    ? listConnections(getDb()).map((c) => ({ id: c.id, type: c.type, name: c.name, enabled: c.enabled }))
    : []
});
