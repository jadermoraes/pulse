// Friendly temperature presets for the AI model pickers.
//
// The backend stores a raw numeric temperature (0–1). The UI presents a small set of
// named presets ("Precise", "Balanced", "Creative") that map to canonical values, plus
// a "Custom…" escape hatch that reveals a number input. These pure mappers keep the
// preset⇄value translation testable and shared.

export type TemperaturePreset = 'precise' | 'balanced' | 'creative' | 'custom';

/** The selectable presets, in display order. `custom` has no canonical value. */
export const TEMPERATURE_PRESETS: { name: TemperaturePreset; value: number | null }[] = [
  { name: 'precise', value: 0.2 },
  { name: 'balanced', value: 0.5 },
  { name: 'creative', value: 0.8 },
  { name: 'custom', value: null }
];

/** Resolve a named preset to its numeric temperature. `custom` ⇒ null (operator-typed). */
export function presetToValue(name: TemperaturePreset): number | null {
  return TEMPERATURE_PRESETS.find((p) => p.name === name)?.value ?? null;
}

/**
 * Map a stored numeric temperature back to a preset name. Values that don't match a
 * canonical preset map to `custom`. When the value is null/undefined, fall back to the
 * supplied default preset (admin → 'precise', consumer → 'balanced').
 */
export function temperaturePreset(
  value: number | null | undefined,
  fallback: TemperaturePreset = 'precise'
): TemperaturePreset {
  if (value == null) return fallback;
  const match = TEMPERATURE_PRESETS.find((p) => p.value !== null && p.value === value);
  return match ? match.name : 'custom';
}
