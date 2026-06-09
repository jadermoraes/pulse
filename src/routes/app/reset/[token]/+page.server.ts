import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { getReset } from '$lib/server/identity/password-reset';

// Pre-session (CONSUMER_PUBLIC). Only reveals whether the token is currently valid — no PII.
export const load: PageServerLoad = ({ params }) => {
  const valid = getReset(getDb(), params.token) != null;
  return { valid };
};
