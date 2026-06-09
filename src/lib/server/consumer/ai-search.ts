import { generateObject, type LanguageModel } from 'ai';
import { z } from 'zod';
import type { DB } from '../db';
import { searchDiscover } from './discover';
import type { DiscoverItem } from './types';

/** Upper bound on suggestions we ask the model for AND resolve — keeps it one bounded call. */
export const AI_SEARCH_MAX = 8;

/** Shape the model returns: a short list of concrete titles matching the vibe query. */
const SuggestionsSchema = z.object({
  titles: z
    .array(
      z.object({
        title: z.string(),
        year: z.number().optional(),
        mediaType: z.enum(['movie', 'tv']).optional()
      })
    )
    .max(AI_SEARCH_MAX)
});

export type AiSuggestion = z.infer<typeof SuggestionsSchema>['titles'][number];

function suggestionPrompt(query: string): string {
  return [
    'You are a film and TV recommender for a home media server.',
    `The user described what they are in the mood for: "${query}".`,
    `Suggest up to ${AI_SEARCH_MAX} real, well-known movie or TV titles that match.`,
    'Return ONLY concrete existing titles (no franchises-in-general, no made-up works).',
    'Prefer exact, searchable titles. Include the release year when you are confident.'
  ].join('\n');
}

/** dedupe key mirroring discover.ts so we collapse duplicate resolved cards. */
function dedupeKey(i: DiscoverItem): string {
  return i.tmdbId != null ? `tmdb:${i.tmdbId}` : `t:${i.title.toLowerCase()}|${i.year ?? ''}`;
}

export interface AiSearchResult {
  items: DiscoverItem[];
  /** Total tokens consumed by the model call (for metering). */
  tokens: number;
}

/**
 * One bounded AI vibe-search:
 *  1. ONE model call → up to AI_SEARCH_MAX concrete titles matching the natural-language query.
 *  2. Resolve EACH suggestion through `searchDiscover` (best match) → a real DiscoverItem
 *     (poster, tmdbId, onServer, watchUrl). Unresolved suggestions are dropped; results deduped.
 * Returns the resolved cards plus the token count to meter against the cap.
 */
export async function aiVibeSearch(db: DB, model: LanguageModel, query: string): Promise<AiSearchResult> {
  const q = query.trim();
  if (!q) return { items: [], tokens: 0 };

  const gen = await generateObject({
    model,
    schema: SuggestionsSchema,
    prompt: suggestionPrompt(q)
  });
  const usage = gen.usage ?? {};
  const tokens = (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0);
  const suggestions = gen.object.titles.slice(0, AI_SEARCH_MAX);

  const items: DiscoverItem[] = [];
  const seen = new Set<string>();
  for (const s of suggestions) {
    let matches: DiscoverItem[] = [];
    try {
      matches = await searchDiscover(db, s.title);
    } catch {
      matches = [];
    }
    // Prefer a year-matching candidate when the model gave a year; else take the first hit.
    const best =
      (s.year != null ? matches.find((m) => m.year === s.year) : undefined) ?? matches[0];
    if (!best) continue;
    const key = dedupeKey(best);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(best);
    if (items.length >= AI_SEARCH_MAX) break;
  }

  return { items, tokens };
}
