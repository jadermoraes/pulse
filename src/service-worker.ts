/// <reference types="@sveltejs/kit" />
import { build, files, version } from '$service-worker';
import { pushNotificationFrom, clickTarget } from '$lib/sw-helpers';

const sw = self as unknown as ServiceWorkerGlobalScope;
const CACHE = `pulse-cache-${version}`;
const PRECACHE = [...build, ...files.filter((f) => /\.(png|svg|webmanifest|ico)$/.test(f))];

sw.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(PRECACHE)).then(() => sw.skipWaiting()));
});

sw.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => sw.clients.claim())
  );
});

sw.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;

  const isBuildAsset = build.some((b) => req.url.endsWith(b));
  if (isBuildAsset) {
    event.respondWith(caches.open(CACHE).then(async (c) => (await c.match(req)) ?? fetch(req)));
    return;
  }
  event.respondWith(
    (async () => {
      try {
        return await fetch(req);
      } catch {
        const cached = await caches.match(req);
        return cached ?? (await caches.match('/app')) ?? Response.error();
      }
    })()
  );
});

sw.addEventListener('push', (event: PushEvent) => {
  let data: unknown = null;
  try { data = event.data?.json() ?? null; } catch { data = null; }
  const n = pushNotificationFrom(data as any);
  event.waitUntil(sw.registration.showNotification(n.title, n.options));
});

sw.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  const url = clickTarget(event.notification.data as any);
  event.waitUntil(
    sw.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/app') && 'focus' in client) return client.focus();
      }
      return sw.clients.openWindow(url);
    })
  );
});
