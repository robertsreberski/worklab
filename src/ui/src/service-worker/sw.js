import { precacheAndRoute, cleanupOutdatedCaches } from "workbox-precaching";
import { registerRoute } from "workbox-routing";
import { NetworkOnly, StaleWhileRevalidate } from "workbox-strategies";
import { installNotificationHandlers } from "./notifications.js";

self.skipWaiting();
cleanupOutdatedCaches();
precacheAndRoute(self.__WB_MANIFEST || []);

// Navigations and HTML stay current-ish but tolerate slow networks.
registerRoute(
  ({ request }) => request.mode === "navigate",
  new StaleWhileRevalidate({ cacheName: "worklab-app-shell" }),
);

// API and SSE must never be served from cache; freshness matters more than bytes.
registerRoute(
  ({ url }) => url.pathname.startsWith("/api/"),
  new NetworkOnly(),
);

installNotificationHandlers(self);
