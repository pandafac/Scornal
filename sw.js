const CACHE_NAME = "scornal-app-shell-2026-08-20-identity-1";
// Identity revision 1: local album picking, cropper, IndexedDB avatars, 8 frames, compliance pages.
const APP_SHELL = [
  "./",
  "./index.html",
  "./src/styles.css",
  "./src/identity-extra.css",
  "./src/main.js",
  "./src/avatar-system.js",
  "./src/avatar-frames.js",
  "./src/avatar-image.js",
  "./src/avatar-storage.js",
  "./src/avatar-cropper.js",
  "./src/compliance-config.js",
  "./manifest.webmanifest",
  "./src/assets/avatar-catalog.json",
  "./src/assets/scornal-cover-hero-v2.png",
  "./src/assets/page-visuals/dashboard-growth-landscape.png",
  "./src/assets/page-visuals/record-writing-ritual.png",
  "./src/assets/page-visuals/list-paper-archive.png",
  "./src/assets/page-visuals/analysis-data-garden.png",
  "./src/assets/page-visuals/profile-personal-collection.png",
  "./src/assets/avatars/web/wolf-friends-scornal-v1.webp",
  "./src/assets/avatars/web/seal-cookie-scornal-v1.webp",
  "./src/assets/avatars/web/frog-lotus-scornal-v1.webp",
  "./src/assets/avatars/web/owl-night-scornal-v1.webp",
  "./src/assets/avatars/web/hippo-ballet-scornal-v1.webp",
  "./src/assets/avatars/web/sloth-race-scornal-v1.webp",
  "./src/assets/avatars/web/penguin-slip-scornal-v1.webp",
  "./src/assets/avatars/web/rabbit-scornal-v1.webp",
  "./src/assets/avatars/web/bear-scornal-v1.webp",
  "./src/assets/avatars/web/panda-scornal-v1.webp",
  "./src/assets/avatars/web/fox-scornal-v1.webp",
  "./src/assets/avatars/web/lion-scornal-v1.webp",
  "./src/assets/avatars/web/cat-scornal-v1.webp",
  "./src/assets/avatars/web/koala-scornal-v1.webp",
  "./src/assets/avatars/web/chicken-scornal-v1.webp",
  "./src/assets/avatars/thumb/wolf-friends-scornal-v1.webp",
  "./src/assets/avatars/thumb/seal-cookie-scornal-v1.webp",
  "./src/assets/avatars/thumb/frog-lotus-scornal-v1.webp",
  "./src/assets/avatars/thumb/owl-night-scornal-v1.webp",
  "./src/assets/avatars/thumb/hippo-ballet-scornal-v1.webp",
  "./src/assets/avatars/thumb/sloth-race-scornal-v1.webp",
  "./src/assets/avatars/thumb/penguin-slip-scornal-v1.webp",
  "./src/assets/avatars/thumb/rabbit-scornal-v1.webp",
  "./src/assets/avatars/thumb/bear-scornal-v1.webp",
  "./src/assets/avatars/thumb/panda-scornal-v1.webp",
  "./src/assets/avatars/thumb/fox-scornal-v1.webp",
  "./src/assets/avatars/thumb/lion-scornal-v1.webp",
  "./src/assets/avatars/thumb/cat-scornal-v1.webp",
  "./src/assets/avatars/thumb/koala-scornal-v1.webp",
  "./src/assets/avatars/thumb/chicken-scornal-v1.webp",
  "./src/assets/avatar-frame/panda-box-v3/nw-01.png",
  "./src/assets/avatar-frame/panda-box-v3/nw-02.png",
  "./src/assets/avatar-frame/panda-box-v3/nw-03.png",
  "./src/assets/avatar-frame/panda-box-v3/ne-01.png",
  "./src/assets/avatar-frame/panda-box-v3/sw-01.png",
  "./src/assets/avatar-frame/panda-box-v3/sw-02.png",
  "./src/assets/avatar-frame/panda-box-v3/sw-03.png",
  "./src/assets/avatar-frame/panda-box-v3/se-01.png",
  "./src/assets/avatar-frame/panda-box-v3/se-02.png",
  "./src/assets/avatar-frame/panda-box-v3/se-03.png",
  "./icons/scornal-icon-192.png",
  "./icons/scornal-icon-512.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith("scornal-app-shell-") && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function isFreshShellRequest(request, url) {
  return request.mode === "navigate"
    || request.destination === "script"
    || request.destination === "style"
    || url.pathname.endsWith(".html")
    || url.pathname.endsWith(".js")
    || url.pathname.endsWith(".css");
}

function fetchAndUpdateCache(request) {
  return fetch(request).then((response) => {
    const clone = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
    return response;
  });
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (isFreshShellRequest(request, url)) {
    event.respondWith(
      fetchAndUpdateCache(request)
        .catch(() => caches.match(request).then((cachedResponse) => cachedResponse || caches.match("./index.html")))
    );
    return;
  }

  event.respondWith(
    caches.match(request)
      .then((cachedResponse) => cachedResponse || fetchAndUpdateCache(request))
  );
});
