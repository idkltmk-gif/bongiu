// Offline cache: the page is fetched fresh when online (so updates arrive), everything else is served from cache.
const V = "even-frames-v3";
const CORE = ["./", "index.html", "manifest.webmanifest", "apple-touch-icon.png", "icon-192.png", "icon-512.png",
  "mp/vision_bundle.mjs", "mp/vision_wasm_internal.js", "mp/vision_wasm_internal.wasm",
  "mp/face_detector.tflite", "mp/pose_landmarker_lite.task", "mp/object_detector.tflite"];

self.addEventListener("install", (e) => { e.waitUntil(caches.open(V).then((c) => c.addAll(CORE)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== V).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  if (req.mode === "navigate") {
    e.respondWith(fetch(req).then((r) => { const copy = r.clone(); caches.open(V).then((c) => c.put("index.html", copy)); return r; })
      .catch(() => caches.match("index.html")));
    return;
  }
  e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((r) => {
    if (r.ok) { const copy = r.clone(); caches.open(V).then((c) => c.put(req, copy)); }
    return r;
  })));
});
