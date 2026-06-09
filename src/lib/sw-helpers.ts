export interface PushData { title?: string; body?: string; url?: string }
export interface BuiltNotification { title: string; options: NotificationOptions }

/** Map a push payload (possibly null/garbage) to a showNotification(title, options) call. */
export function pushNotificationFrom(data: PushData | null | undefined): BuiltNotification {
  const url = (data && typeof data.url === 'string' && data.url) || '/app';
  return {
    title: (data && typeof data.title === 'string' && data.title) || 'Pulse',
    options: {
      body: (data && typeof data.body === 'string' && data.body) || 'You have a new notification',
      data: { url },
      icon: '/icon-192.png',
      badge: '/icon-192.png'
    }
  };
}

/** Where a notification click should navigate. */
export function clickTarget(data: PushData | null | undefined): string {
  return (data && typeof data.url === 'string' && data.url) || '/app';
}
