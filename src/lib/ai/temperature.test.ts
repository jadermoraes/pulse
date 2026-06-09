import { describe, it, expect } from 'vitest';
import {
  TEMPERATURE_PRESETS,
  presetToValue,
  temperaturePreset,
  type TemperaturePreset
} from './temperature';

describe('temperature presets', () => {
  it('exposes the three named presets plus Custom', () => {
    const names = TEMPERATURE_PRESETS.map((p) => p.name);
    expect(names).toEqual(['precise', 'balanced', 'creative', 'custom']);
  });

  it('presetToValue maps named presets to their numeric value', () => {
    expect(presetToValue('precise')).toBe(0.2);
    expect(presetToValue('balanced')).toBe(0.5);
    expect(presetToValue('creative')).toBe(0.8);
  });

  it('presetToValue returns null for custom (no canonical value)', () => {
    expect(presetToValue('custom')).toBeNull();
  });

  it('temperaturePreset maps exact preset values back to their name', () => {
    expect(temperaturePreset(0.2)).toBe('precise');
    expect(temperaturePreset(0.5)).toBe('balanced');
    expect(temperaturePreset(0.8)).toBe('creative');
  });

  it('temperaturePreset returns custom for any non-preset value', () => {
    expect(temperaturePreset(0.3)).toBe('custom');
    expect(temperaturePreset(0)).toBe('custom');
    expect(temperaturePreset(1)).toBe('custom');
  });

  it('temperaturePreset falls back to the admin default (precise) when value is undefined', () => {
    expect(temperaturePreset(undefined, 'precise')).toBe('precise');
    expect(temperaturePreset(null, 'precise')).toBe('precise');
  });

  it('temperaturePreset falls back to the consumer default (balanced) when value is undefined', () => {
    expect(temperaturePreset(undefined, 'balanced')).toBe('balanced');
  });

  it('round-trips named presets', () => {
    for (const name of ['precise', 'balanced', 'creative'] as TemperaturePreset[]) {
      expect(temperaturePreset(presetToValue(name)!)).toBe(name);
    }
  });
});
