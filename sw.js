// Offline support without a big first download: files are kept as the app uses them.
// Page: network first (updates arrive at once). Models in mp/: cache first (they never change in place).
// Everything else: served from cache, refreshed in the background.
const V = "even-frames-5";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
const put = (req, res) => { if (res.ok) { const copy = res.clone(); caches.open(V).then((c) => c.put(req, copy)); } return res; };
// The page sends the files it already loaded; take them from the browser's HTTP cache when possible.
self.addEventListener("message", (e) => {
  const urls = (e.data?.keep || []).filter((u) => new URL(u).origin === location.origin);
  e.waitUntil(caches.open(V).then((c) => Promise.all(urls.map((u) => c.match(u).then((hit) => hit ||
    fetch(new Request(u, { cache: "force-cache" })).then((r) => (r.ok ? c.put(u, r) : null)).catch(() => null))))));
});
self.addEventListener("fetch", (e) => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((r) => put("index.html", r)).catch(() => caches.match("index.html")));
  } else if (url.pathname.includes("/mp/")) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => put(req, r))));
  } else {
    e.respondWith(caches.match(req).then((hit) => { const net = fetch(req).then((r) => put(req, r)); return hit || net; }));
  }
});
