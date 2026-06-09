import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDb } from '$lib/server/db';
import { getConsumer } from '$lib/server/identity/consumers';
import { getRole } from '$lib/server/identity/roles';
import { isOverCap, addUsage } from '$lib/server/identity/usage';
import { getConsumerModel } from '$lib/server/agent/provider';
import { aiVibeSearch } from '$lib/server/consumer/ai-search';

/**
 * Consumer-gated AI "vibe search": a natural-language query → up to 8 resolved DiscoverItem cards.
 * Cap-gated FIRST (over cap ⇒ `{ blocked: 'cap' }`, no model call). Otherwise ONE consumer-model
 * call suggests titles, each resolved through searchDiscover; the spent tokens are metered with
 * addUsage. Never blocks discover/search — those don't hit the LLM.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.consumer) throw error(401, 'Unauthorized');
  const db = getDb();

  let body: { q?: string };
  try { body = await request.json(); } catch { throw error(400, 'Invalid JSON body'); }
  const q = typeof body.q === 'string' ? body.q.trim() : '';
  if (!q) return json({ items: [] });

  const consumer = getConsumer(db, locals.consumer.id);
  if (!consumer) throw error(401, 'Unauthorized');
  const role = getRole(db, consumer.roleId);
  if (!role) throw error(401, 'Unauthorized');

  // Cap-gate before any model call.
  if (isOverCap(db, consumer, role)) return json({ blocked: 'cap' });

  const model = getConsumerModel(db);
  if (!model) throw error(503, 'AI search is not available');

  const { items, tokens } = await aiVibeSearch(db, model, q);
  if (tokens > 0) addUsage(db, consumer.id, tokens);
  return json({ items });
};
