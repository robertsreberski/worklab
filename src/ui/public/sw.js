function subscriptionJson(subscription) {
  if (!subscription) return null;
  return typeof subscription.toJSON === "function" ? subscription.toJSON() : subscription;
}

function base64UrlToUint8Array(value) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((char) => char.charCodeAt(0)));
}

async function notificationStatus() {
  const response = await fetch("/api/notifications/status");
  if (!response.ok) throw new Error(`notification status failed: ${response.status}`);
  return response.json();
}

async function deleteSubscription(endpoint) {
  if (!endpoint) return;
  await fetch("/api/notifications/subscriptions", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}

async function saveSubscription(subscription) {
  const normalized = subscriptionJson(subscription);
  if (!normalized?.endpoint) return;
  await fetch("/api/notifications/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: normalized, clientKind: "pwa" }),
  });
}

async function subscribeWithServerKey() {
  const status = await notificationStatus();
  const publicKey = status?.notifications?.pwa?.publicKey;
  if (!publicKey || !self.registration?.pushManager) return null;
  return self.registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array(publicKey),
  });
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = {};
  }
  const title = payload.title || "Worklab";
  const options = {
    body: payload.body || "",
    tag: payload.tag || "worklab",
    data: payload.data || {},
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil((async () => {
    const oldEndpoint = event.oldSubscription?.endpoint;
    const next = event.newSubscription || await subscribeWithServerKey();
    if (oldEndpoint && oldEndpoint !== next?.endpoint) await deleteSubscription(oldEndpoint);
    await saveSubscription(next);
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const route = event.notification.data?.route || "#/";
  const targetUrl = new URL(`/${route.startsWith("#") ? route : `#${route}`}`, self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (!client.url.startsWith(self.location.origin)) continue;
      if (client.navigate) await client.navigate(targetUrl);
      return client.focus();
    }
    return self.clients.openWindow(targetUrl);
  })());
});
