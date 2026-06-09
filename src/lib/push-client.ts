// Shared browser-side web-push subscription helper.
// Used by /app/account ("Enable notifications") and /app/join onboarding.

function urlBase64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export type PushFailReason = 'insecure' | 'unsupported' | 'ios-install' | 'denied' | 'error';
export type PushResult = { ok: true } | { ok: false; reason: PushFailReason };

/** Human message for a push failure reason (UI shows this so the button is never silent). */
export function pushFailMessage(reason: PushFailReason): string {
  switch (reason) {
    case 'insecure': return 'Notifications need a secure (https) connection. Open Pulse over https and try again.';
    case 'ios-install': return 'On iPhone/iPad, add Pulse to your Home Screen first (Share → Add to Home Screen), then enable notifications from the installed app.';
    case 'denied': return 'Notifications are blocked for this site. Enable them in your browser settings, then try again.';
    case 'unsupported': return "This browser doesn't support web notifications.";
    default: return "Couldn't enable notifications. Please try again.";
  }
}

/** Request permission, subscribe via the SW push manager, register server-side. Returns why it failed. */
export async function enablePush(): Promise<PushResult> {
  try {
    if (typeof window !== 'undefined' && window.isSecureContext === false) return { ok: false, reason: 'insecure' };
    const isIOS = typeof navigator !== 'undefined' && /iphone|ipad|ipod/i.test(navigator.userAgent);
    const standalone =
      (typeof window !== 'undefined' && window.matchMedia?.('(display-mode: standalone)').matches) ||
      (typeof navigator !== 'undefined' && (navigator as any).standalone === true);
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
      return { ok: false, reason: isIOS && !standalone ? 'ios-install' : 'unsupported' };
    }
    if ((await Notification.requestPermission()) !== 'granted') return { ok: false, reason: 'denied' };
    // Don't hang forever if the SW never becomes ready.
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8000))
    ]);
    if (!reg) return { ok: false, reason: 'error' };
    const { publicKey } = await (await fetch('/api/app/push/vapid')).json();
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    await fetch('/api/app/push/subscribe', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub)
    });
    return { ok: true };
  } catch {
    return { ok: false, reason: 'error' };
  }
}
