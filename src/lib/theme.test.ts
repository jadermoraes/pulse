import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  THEMES,
  applyTheme,
  applyCustomTheme,
  loadCustomColors,
  CUSTOM_DEFAULTS,
  applyDensity,
  loadDensity,
  saveClockFormat,
  loadClockFormat,
  formatClock
} from './theme';

describe('THEMES', () => {
  it('has all four theme keys', () => {
    expect(Object.keys(THEMES)).toEqual(expect.arrayContaining(['emerald', 'aurora', 'nova', 'ember']));
  });

  it('each theme has accent and accent2 hex strings', () => {
    for (const [, t] of Object.entries(THEMES)) {
      expect(t.accent).toMatch(/^#[0-9a-f]{6}$/i);
      expect(t.accent2).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('emerald is the default (first) theme', () => {
    expect(THEMES.emerald).toEqual({ accent: '#28e0a0', accent2: '#36c6ff' });
  });
});

// ── shared mock setup ─────────────────────────────────────────────
function makeMocks() {
  const styleMap = new Map<string, string>();
  const localStorageMap = new Map<string, string>();
  const attrs = new Map<string, string>();

  const mockRoot = {
    style: {
      setProperty: (prop: string, val: string) => { styleMap.set(prop, val); }
    },
    setAttribute: (attr: string, val: string) => { attrs.set(attr, val); }
  };

  vi.stubGlobal('document', { documentElement: mockRoot });
  vi.stubGlobal('localStorage', {
    setItem: (k: string, v: string) => { localStorageMap.set(k, v); },
    getItem: (k: string) => localStorageMap.get(k) ?? null
  });

  return { styleMap, localStorageMap, attrs };
}

describe('applyTheme', () => {
  let mocks: ReturnType<typeof makeMocks>;

  beforeEach(() => { mocks = makeMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sets CSS custom properties for a known theme', () => {
    applyTheme('aurora');
    expect(mocks.styleMap.get('--accent')).toBe(THEMES.aurora.accent);
    expect(mocks.styleMap.get('--accent2')).toBe(THEMES.aurora.accent2);
  });

  it('falls back to emerald for an unknown theme name', () => {
    applyTheme('bogus');
    expect(mocks.styleMap.get('--accent')).toBe(THEMES.emerald.accent);
    expect(mocks.styleMap.get('--accent2')).toBe(THEMES.emerald.accent2);
  });

  it('persists the theme name to localStorage', () => {
    applyTheme('nova');
    expect(mocks.localStorageMap.get('pulse.theme')).toBe('nova');
  });

  it('does not throw when document is undefined (SSR guard)', () => {
    vi.unstubAllGlobals();
    expect(() => applyTheme('emerald')).not.toThrow();
  });
});

describe('applyCustomTheme', () => {
  let mocks: ReturnType<typeof makeMocks>;

  beforeEach(() => { mocks = makeMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('applies custom colors as CSS properties', () => {
    applyCustomTheme({ accent: '#ff0000', accent2: '#0000ff' });
    expect(mocks.styleMap.get('--accent')).toBe('#ff0000');
    expect(mocks.styleMap.get('--accent2')).toBe('#0000ff');
  });

  it('persists "custom" theme key and colors to localStorage', () => {
    applyCustomTheme({ accent: '#aabbcc', accent2: '#ddeeff' });
    expect(mocks.localStorageMap.get('pulse.theme')).toBe('custom');
    const stored = JSON.parse(mocks.localStorageMap.get('pulse.custom')!);
    expect(stored).toEqual({ accent: '#aabbcc', accent2: '#ddeeff' });
  });

  it('does not throw when document is undefined (SSR guard)', () => {
    vi.unstubAllGlobals();
    expect(() => applyCustomTheme({ accent: '#abc', accent2: '#def' })).not.toThrow();
  });
});

describe('loadCustomColors', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns stored custom colors from localStorage', () => {
    const stored = { accent: '#112233', accent2: '#445566' };
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => k === 'pulse.custom' ? JSON.stringify(stored) : null,
      setItem: vi.fn()
    });
    expect(loadCustomColors()).toEqual(stored);
  });

  it('returns CUSTOM_DEFAULTS when nothing is stored', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: vi.fn()
    });
    expect(loadCustomColors()).toEqual(CUSTOM_DEFAULTS);
  });

  it('returns CUSTOM_DEFAULTS when stored JSON is malformed', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => 'not-json{{{',
      setItem: vi.fn()
    });
    expect(loadCustomColors()).toEqual(CUSTOM_DEFAULTS);
  });
});

describe('applyDensity', () => {
  let mocks: ReturnType<typeof makeMocks>;

  beforeEach(() => { mocks = makeMocks(); });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('sets data-density attribute on documentElement', () => {
    applyDensity('compact');
    expect(mocks.attrs.get('data-density')).toBe('compact');
  });

  it('persists density to localStorage', () => {
    applyDensity('comfy');
    expect(mocks.localStorageMap.get('pulse.density')).toBe('comfy');
  });

  it('does not throw when document is undefined (SSR guard)', () => {
    vi.unstubAllGlobals();
    expect(() => applyDensity('compact')).not.toThrow();
  });
});

describe('loadDensity', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('returns stored density', () => {
    vi.stubGlobal('localStorage', { getItem: (k: string) => k === 'pulse.density' ? 'compact' : null, setItem: vi.fn() });
    expect(loadDensity()).toBe('compact');
  });

  it('defaults to comfy when not stored', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    expect(loadDensity()).toBe('comfy');
  });
});

describe('saveClockFormat / loadClockFormat', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it('saves and retrieves 12h', () => {
    const map = new Map<string, string>();
    vi.stubGlobal('localStorage', { setItem: (k: string, v: string) => map.set(k, v), getItem: (k: string) => map.get(k) ?? null });
    saveClockFormat('12h');
    expect(loadClockFormat()).toBe('12h');
  });

  it('defaults to 24h when not stored', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: vi.fn() });
    expect(loadClockFormat()).toBe('24h');
  });
});

describe('formatClock', () => {
  const d = new Date('2024-01-15T14:05:00'); // Mon, 14:05

  it('formats in 24h mode', () => {
    const result = formatClock(d, '24h');
    expect(result).toMatch(/^Mon · 14:05$/);
  });

  it('formats in 12h mode', () => {
    const result = formatClock(d, '12h');
    expect(result).toMatch(/^Mon · 2:05 PM$/);
  });

  it('handles midnight correctly in 12h mode', () => {
    const midnight = new Date('2024-01-15T00:05:00');
    const result = formatClock(midnight, '12h');
    expect(result).toMatch(/^Mon · 12:05 AM$/);
  });

  it('handles noon correctly in 12h mode', () => {
    const noon = new Date('2024-01-15T12:05:00');
    const result = formatClock(noon, '12h');
    expect(result).toMatch(/^Mon · 12:05 PM$/);
  });
});
