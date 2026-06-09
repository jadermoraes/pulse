import { redirect } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { destroySession } from '$lib/server/auth';
export const POST = async ({ cookies }: { cookies: import('@sveltejs/kit').Cookies }) => {
  const sid = cookies.get('pulse_session');
  if (sid) destroySession(getDb(), sid);
  cookies.delete('pulse_session', { path: '/' });
  throw redirect(303, '/login');
};
