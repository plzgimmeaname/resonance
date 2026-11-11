// network-first for this site's own files. covers and previews from spotify/itunes are left to the browser:
// re-fetching them from here falls under the CSP's connect-src 'self', which blocks them and breaks every image
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api")) return;
  e.respondWith(
    fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open("shell").then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request)),
  );
});
