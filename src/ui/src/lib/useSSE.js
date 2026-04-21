import { useEffect } from "preact/hooks";

export function useSSE(channel, onEvent) {
  useEffect(() => {
    const es = new EventSource(`/api/events/stream`);
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        onEvent(payload);
      } catch { /* ignore parse errors */ }
    };
    return () => es.close();
  }, [channel]);
}
