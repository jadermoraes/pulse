import type { PageServerLoad } from './$types';
import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { listMessages } from '$lib/server/consumer/messages';

export const load: PageServerLoad = async ({ locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  return { messages: listMessages(getDb(), {}) };
};
