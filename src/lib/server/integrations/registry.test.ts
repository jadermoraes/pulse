import { describe, it, expect } from 'vitest';
import { registerIntegration, getIntegration, listIntegrations } from './registry';
import type { Integration } from './types';

const fake: Integration = { type: 'fake', label: 'Fake', icon: 'x', configSchema: [],
  async testConnection() { return { ok: true, message: 'ok' }; }, widgets: {} };

describe('registry', () => {
  it('registers and retrieves integrations', () => {
    registerIntegration(fake);
    expect(getIntegration('fake')?.label).toBe('Fake');
    expect(listIntegrations().some((i) => i.type === 'fake')).toBe(true);
    expect(getIntegration('nope')).toBeUndefined();
  });
});
