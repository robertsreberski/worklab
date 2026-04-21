export function createSseBroker() {
  const channels = new Map(); // name → Set<res>

  function subscribe(name, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });
    res.write(": connected\n\n");
    let set = channels.get(name);
    if (!set) channels.set(name, (set = new Set()));
    set.add(res);
    res.on("close", () => unsubscribe(name, res));
  }

  function unsubscribe(name, res) {
    const set = channels.get(name);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) channels.delete(name);
  }

  function broadcast(name, payload) {
    const set = channels.get(name);
    if (!set) return;
    const line = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of set) {
      try { res.write(line); } catch { /* client went away */ }
    }
  }

  function size(name) {
    return channels.get(name)?.size ?? 0;
  }

  return { subscribe, unsubscribe, broadcast, size };
}
