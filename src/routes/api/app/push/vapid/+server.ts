import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getVapidKeys } from '$lib/server/consumer/push';

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  return json({ publicKey: getVapidKeys(getDb()).publicKey });
};
