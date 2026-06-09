import type { PageServerLoad } from './$types';
import { getDb } from '$lib/server/db';
import { getSetting } from '$lib/server/settings';
import type { SavedLayoutEntry } from '$lib/dashboard';
import { listIntegrations } from '$lib/server/integrations';

const LAYOUT_KEY = 'dashboard_layout';

export const load: PageServerLoad = async () => {
  let layout: SavedLayoutEntry[] = [];
  const raw = getSetting(getDb(), LAYOUT_KEY);
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) layout = parsed as SavedLayoutEntry[];
    } catch {
      layout = [];
    }
  }
  // Expose available integration types for the first-run welcome state.
  const integrations = listIntegrations().map((i) => ({ type: i.type, label: i.label }));
  return { layout, integrations };
};
