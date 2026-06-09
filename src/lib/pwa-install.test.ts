import { describe, it, expect } from 'vitest';
import { shouldShowInstall } from './pwa-install';

it('shows the Android button when a beforeinstallprompt event is captured', () => {
  expect(shouldShowInstall({ isStandalone: false, isIOS: false, dismissed: false, hasBeforeInstall: true })).toBe('android');
});
it('shows the iOS hint on iOS Safari when not standalone and not dismissed', () => {
  expect(shouldShowInstall({ isStandalone: false, isIOS: true, dismissed: false, hasBeforeInstall: false })).toBe('ios');
});
it('shows nothing when already installed (standalone)', () => {
  expect(shouldShowInstall({ isStandalone: true, isIOS: true, dismissed: false, hasBeforeInstall: true })).toBe('none');
});
it('shows nothing once dismissed', () => {
  expect(shouldShowInstall({ isStandalone: false, isIOS: true, dismissed: true, hasBeforeInstall: false })).toBe('none');
});
it('shows nothing on a desktop browser with no install event', () => {
  expect(shouldShowInstall({ isStandalone: false, isIOS: false, dismissed: false, hasBeforeInstall: false })).toBe('none');
});
