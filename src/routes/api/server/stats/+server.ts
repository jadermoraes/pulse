import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { collectStats } from '$lib/server/metrics';

// Mounts to report; PULSE_DISK_MOUNTS is a comma-separated list, defaults to '/'.
function mounts(): string[] {
  const raw = process.env.PULSE_DISK_MOUNTS;
  return raw ? raw.split(',').map((m) => m.trim()).filter(Boolean) : ['/'];
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');
  const stats = await collectStats({ mounts: mounts(), sampleMs: 200 });
  return json(stats);
};
