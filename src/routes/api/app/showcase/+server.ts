import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getShowcasePosters } from '$lib/server/consumer/showcase';

// PUBLIC (no auth) — see CONSUMER_PUBLIC + isPublicHostAllowed in hooks.server.ts.
// Returns ONLY public TMDB poster URLs for the cinematic login/onboarding backdrops.
export const GET: RequestHandler = async () => {
  const posters = await getShowcasePosters(getDb());
  return json({ posters });
};
