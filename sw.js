// Offline support without a big first download: files are kept as the app uses them.
// Models and engines in mp/: cache first (they never change in place; a new model gets a new file name).
// Everything else (page, js/, style.css, icons): network first, revalidated every time, cache when offline.
// The page and its scripts must always be the same version, so none of them is served stale.
const V = "bongiu-1";
const OLD = ["even-frames-5"]; // earlier cache names: their models are carried over, not downloaded again

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const cache = await caches.open(V);
      for (const name of OLD) {
        if (!(await caches.has(name))) continue;
        const old = await caches.open(name);
        for (const req of await old.keys()) {
          if (new URL(req.url).pathname.includes("/mp/")) await cache.put(req, await old.match(req));
        }
      }
      for (const k of await caches.keys()) if (k !== V) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

const put = (req, res) => {
  if (res.ok) {
    const copy = res.clone();
    caches.open(V).then((c) => c.put(req, copy));
  }
  return res;
};

// The page sends the files it already loaded; take them from the browser's HTTP cache when possible.
self.addEventListener("message", (e) => {
  const urls = (e.data?.keep || []).filter((u) => new URL(u).origin === location.origin);
  e.waitUntil(
    caches.open(V).then((c) =>
      Promise.all(
        urls.map((u) =>
          c.match(u).then(
            (hit) =>
              hit ||
              fetch(new Request(u, { cache: "force-cache" }))
                .then((r) => (r.ok ? c.put(u, r) : null))
                .catch(() => null),
          ),
        ),
      ),
    ),
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.includes("/mp/")) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => put(req, r))));
  } else if (req.mode === "navigate") {
    // no-cache = ask the server whether the page changed (a cheap 304 when it did not)
    e.respondWith(
      fetch(req.url, { cache: "no-cache" })
        .then((r) => put("index.html", r))
        .catch(() => caches.match("index.html")),
    );
  } else {
    e.respondWith(
      fetch(req, { cache: "no-cache" })
        .then((r) => put(req, r))
        .catch(() => caches.match(req)),
    );
  }
});
