// network-first
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET" || new URL(e.request.url).pathname.startsWith("/api")) return;
  e.respondWith(
    fetch(e.request).then((r) => {
      const copy = r.clone();
      caches.open("shell").then((c) => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request)),
  );
});
