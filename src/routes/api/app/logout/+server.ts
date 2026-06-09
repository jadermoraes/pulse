import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { destroyConsumerSession } from '$lib/server/identity/consumer-auth';

export const POST: RequestHandler = async ({ cookies }) => {
  const sid = cookies.get('pulse_app');
  if (sid) destroyConsumerSession(getDb(), sid);
  cookies.delete('pulse_app', { path: '/' });
  return json({ ok: true });
};
