import { describe, it, expect } from 'vitest';
import { pushNotificationFrom, clickTarget } from './sw-helpers';

it('pushNotificationFrom maps a full payload to title + options', () => {
  const n = pushNotificationFrom({ title: 'Ready to watch', body: 'Dune is now available', url: '/app/requests' });
  expect(n.title).toBe('Ready to watch');
  expect(n.options.body).toBe('Dune is now available');
  expect(n.options.data).toEqual({ url: '/app/requests' });
  expect(n.options.icon).toBe('/icon-192.png');
});

it('pushNotificationFrom falls back to a generic notification for a bad/empty payload', () => {
  const n = pushNotificationFrom(null);
  expect(n.title).toBe('Pulse');
  expect(typeof n.options.body).toBe('string');
  expect(n.options.data).toEqual({ url: '/app' });
});

it('clickTarget returns the payload url or defaults to /app', () => {
  expect(clickTarget({ url: '/app/discover' })).toBe('/app/discover');
  expect(clickTarget({})).toBe('/app');
  expect(clickTarget(null)).toBe('/app');
});
