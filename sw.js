self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});

self.addEventListener("push", (event) => {
  event.waitUntil((async () => {
    let d = {};
    try { d = event.data ? event.data.json() : {}; } catch (e) { d = {}; }
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (!d.force && wins.some((w) => w.visibilityState === "visible")) return;
    await self.registration.showNotification(d.title || "Memo", {
      body: d.body || "",
      icon: "icon-192.png",
      badge: "icon-192.png",
      tag: d.tag || "memo",
      renotify: true,
      requireInteraction: !!d.call,
      vibrate: d.call ? [300, 200, 300, 200, 300] : [100],
      data: { url: d.url || "./" },
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "./", self.registration.scope).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      return self.clients.openWindow(url);
    }),
  );
});
