import { describe, it, expect } from 'vitest';
import { capabilityForTool, toolAllowed } from './capabilities';

describe('capability → tool map', () => {
  it('classifies read tools to discover/status capabilities', () => {
    expect(capabilityForTool('getWidget')).toBe('discover');
    expect(capabilityForTool('getMediaDetail')).toBe('discover');
    expect(capabilityForTool('searchMedia')).toBe('discover');
    expect(capabilityForTool('getEvents')).toBe('status');
    expect(capabilityForTool('getNowPlaying')).toBe('status');
  });
  it('allows searchMedia under the discover capability', () => {
    expect(toolAllowed('searchMedia', ['discover'])).toBe(true);
    expect(toolAllowed('searchMedia', ['request'])).toBe(false);
  });
  it('classifies the request write tool to the request capability', () => {
    expect(capabilityForTool('runAction')).toBe('request');
  });
  it('returns null for ungoverned/admin-only tools', () => {
    expect(capabilityForTool('restartContainer')).toBeNull();
    expect(capabilityForTool('listContainers')).toBeNull();
  });
  it('toolAllowed honors the allow-list and denies ungoverned tools for consumers', () => {
    expect(toolAllowed('getWidget', ['discover', 'request'])).toBe(true);
    expect(toolAllowed('runAction', ['discover'])).toBe(false);       // request not granted
    expect(toolAllowed('restartContainer', ['discover', 'request', 'status', 'watchlist', 'message_admin']))
      .toBe(false);                                                    // ungoverned → never for consumers
  });
});
