import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { restartContainer, stopContainer, containerLogs } from '$lib/server/docker';

// Allowlist: only these container actions are ever dispatched.
const ACTIONS = new Set(['restart', 'stop', 'logs']);

// Docker container ids are hex strings (short or full) or user-defined names
// (alphanumeric, underscores, hyphens, dots). Reject anything that deviates.
const CONTAINER_ID_RE = /^[a-zA-Z0-9_.-]+$/;

export const POST: RequestHandler = async ({ params, locals }) => {
  if (!locals.user) throw error(401, 'Unauthorized');   // auth before anything
  const action = params.action;
  if (!ACTIONS.has(action)) throw error(400, 'Unknown action');
  const id = params.id;
  if (!CONTAINER_ID_RE.test(id)) throw error(400, 'Invalid container id');

  if (action === 'restart') return json(await restartContainer(id));
  if (action === 'stop') return json(await stopContainer(id));
  // logs
  return json(await containerLogs(id));
};
