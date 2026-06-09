export interface InstallState {
  isStandalone: boolean;
  isIOS: boolean;
  dismissed: boolean;
  hasBeforeInstall: boolean;
}
export type InstallVariant = 'android' | 'ios' | 'none';

/** Decide which install nudge (if any) to show. Pure — drives the component. */
export function shouldShowInstall(s: InstallState): InstallVariant {
  if (s.isStandalone || s.dismissed) return 'none';
  if (s.hasBeforeInstall) return 'android';
  if (s.isIOS) return 'ios';
  return 'none';
}
