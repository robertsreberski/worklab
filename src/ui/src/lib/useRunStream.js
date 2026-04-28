// src/ui/src/lib/useRunStream.js
import { useEffect, useRef, useState } from "preact/hooks";

function eventKey(event) {
  if (!event) return null;
  if (event._event_seq != null) return `seq:${event._event_seq}`;
  if (event.id != null) return `id:${event.id}`;
  try {
    return `json:${JSON.stringify(event)}`;
  } catch {
    return null;
  }
}

export function mergeRunEvents(current = [], incoming = []) {
  const merged = [];
  const positions = new Map();
  for (const event of [...(current || []), ...(incoming || [])]) {
    if (!event) continue;
    const key = eventKey(event);
    if (key && positions.has(key)) {
      merged[positions.get(key)] = event;
      continue;
    }
    if (key) positions.set(key, merged.length);
    merged.push(event);
  }
  return merged.sort((a, b) => {
    if (a?._event_seq == null || b?._event_seq == null) return 0;
    return Number(a._event_seq) - Number(b._event_seq);
  });
}

export function useRunStream(runId, { subscribe = true } = {}) {
  const [events, setEvents] = useState([]);
  const [run, setRun] = useState(null);
  const [done, setDone] = useState(false);
  const [loading, setLoading] = useState(false);
  const esRef = useRef(null);

  useEffect(() => {
    if (!runId) {
      setEvents([]);
      setRun(null);
      setDone(false);
      setLoading(false);
      return;
    }
    setEvents([]); setRun(null); setDone(false); setLoading(true);
    const controller = new AbortController();
    let cancelled = false;
    let runRefreshTimer = null;
    function clearRunRefresh() {
      if (runRefreshTimer) clearTimeout(runRefreshTimer);
      runRefreshTimer = null;
    }
    function hydrateRun() {
      clearRunRefresh();
      // Preload any already-recorded events (run may have ended before we connected)
      return fetch(`/api/runs/${runId}`, { signal: controller.signal }).then(r => r.ok ? r.json() : null).then(data => {
        if (cancelled) return;
        if (data?.run) setRun(data.run);
        if (data?.log?.events?.length) setEvents((prev) => mergeRunEvents(prev, data.log.events));
        const status = data?.run?.process_status || data?.run?.status;
        if (status && status !== "running") setDone(true);
        const liveInput = data?.run?.live_input;
        if (subscribe && status === "running" && liveInput?.supported && !liveInput.active) {
          runRefreshTimer = setTimeout(hydrateRun, 1000);
        }
      }).catch(() => {}).finally(() => { if (!cancelled) setLoading(false); });
    }
    hydrateRun();
    if (!subscribe) return () => { cancelled = true; controller.abort(); };
    const es = new EventSource(`/api/runs/${runId}/stream`);
    esRef.current = es;
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.type === "done") { setDone(true); es.close(); return; }
        setEvents(prev => mergeRunEvents(prev, [payload]));
      } catch {}
    };
    es.onerror = () => { es.close(); };
    return () => { cancelled = true; clearRunRefresh(); controller.abort(); es.close(); };
  }, [runId, subscribe]);

  return { events, run, done, loading };
}
