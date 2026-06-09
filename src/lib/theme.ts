export const THEMES: Record<string, { accent: string; accent2: string }> = {
  emerald: { accent: '#28e0a0', accent2: '#36c6ff' },
  aurora:  { accent: '#4f9cf9', accent2: '#7c5cff' },
  nova:    { accent: '#a78bfa', accent2: '#ec4899' },
  ember:   { accent: '#ff5c7a', accent2: '#ffa057' }
};

/** Default palette when the user first switches to Custom. */
export const CUSTOM_DEFAULTS = { accent: '#8b5cf6', accent2: '#06b6d4' };

/** Swatches offered as quick-start custom palettes [label, accent, accent2]. */
export const CUSTOM_SWATCHES: Array<{ label: string; accent: string; accent2: string }> = [
  { label: 'Violet',   accent: '#8b5cf6', accent2: '#06b6d4' },
  { label: 'Rose',     accent: '#f43f5e', accent2: '#fb923c' },
  { label: 'Sky',      accent: '#0ea5e9', accent2: '#a78bfa' },
  { label: 'Lime',     accent: '#84cc16', accent2: '#facc15' },
];

export function applyTheme(name: string): void {
  if (typeof document === 'undefined') return; // SSR guard
  const t = THEMES[name] ?? THEMES.emerald;
  const r = document.documentElement;
  r.style.setProperty('--accent', t.accent);
  r.style.setProperty('--accent2', t.accent2);
  localStorage.setItem('pulse.theme', name);
}

export interface CustomColors { accent: string; accent2: string }

export function applyCustomTheme(colors: CustomColors): void {
  if (typeof document === 'undefined') return; // SSR guard
  const r = document.documentElement;
  r.style.setProperty('--accent', colors.accent);
  r.style.setProperty('--accent2', colors.accent2);
  localStorage.setItem('pulse.theme', 'custom');
  localStorage.setItem('pulse.custom', JSON.stringify(colors));
}

export function loadCustomColors(): CustomColors {
  if (typeof localStorage === 'undefined') return CUSTOM_DEFAULTS;
  try {
    const raw = localStorage.getItem('pulse.custom');
    if (raw) return JSON.parse(raw) as CustomColors;
  } catch { /* ignore */ }
  return CUSTOM_DEFAULTS;
}

// ── Density ──────────────────────────────────────────────────────

export type Density = 'comfy' | 'compact';

export function applyDensity(density: Density): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-density', density);
  localStorage.setItem('pulse.density', density);
}

export function loadDensity(): Density {
  if (typeof localStorage === 'undefined') return 'comfy';
  return (localStorage.getItem('pulse.density') as Density) ?? 'comfy';
}

// ── Clock format ─────────────────────────────────────────────────

export type ClockFormat = '12h' | '24h';

export function saveClockFormat(fmt: ClockFormat): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem('pulse.clock', fmt);
}

export function loadClockFormat(): ClockFormat {
  if (typeof localStorage === 'undefined') return '24h';
  return (localStorage.getItem('pulse.clock') as ClockFormat) ?? '24h';
}

export function formatClock(now: Date, fmt: ClockFormat): string {
  const day = now.toLocaleDateString('en-US', { weekday: 'short' });
  if (fmt === '12h') {
    let h = now.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    const mm = String(now.getMinutes()).padStart(2, '0');
    return `${day} · ${h}:${mm} ${ampm}`;
  }
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return `${day} · ${hh}:${mm}`;
}
