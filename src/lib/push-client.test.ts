import { describe, it, expect } from 'vitest';
import { pushFailMessage } from './push-client';

it('maps each reason to a non-empty, distinct message', () => {
  const reasons = ['insecure', 'ios-install', 'denied', 'unsupported', 'error'] as const;
  const msgs = reasons.map(pushFailMessage);
  msgs.forEach((m) => expect(m.length).toBeGreaterThan(10));
  expect(new Set(msgs).size).toBe(reasons.length); // all distinct
  expect(pushFailMessage('insecure')).toMatch(/https/i);
  expect(pushFailMessage('ios-install')).toMatch(/home screen/i);
});
