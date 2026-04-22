// src/ui/src/lib/useRunStream.js
import { useEffect, useRef, useState } from "preact/hooks";

export function useRunStream(runId) {
  const [events, setEvents] = useState([]);
  const [done, setDone] = useState(false);
  const esRef = useRef(null);

  useEffect(() => {
    if (!runId) return;
    setEvents([]); setDone(false);
    // Preload any already-recorded events (run may have ended before we connected)
    fetch(`/api/runs/${runId}`).then(r => r.ok ? r.json() : null).then(data => {
      if (data?.log?.events?.length) setEvents(data.log.events);
      if (data?.run?.status && data.run.status !== "running") setDone(true);
    }).catch(() => {});
    const es = new EventSource(`/api/runs/${runId}/stream`);
    esRef.current = es;
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        if (payload.type === "done") { setDone(true); es.close(); return; }
        setEvents(prev => [...prev, payload]);
      } catch {}
    };
    es.onerror = () => { es.close(); };
    return () => { es.close(); };
  }, [runId]);

  return { events, done };
}
