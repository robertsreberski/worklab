import { useEffect, useRef } from "preact/hooks";

export function useSSE(channel, onEvent) {
  const cbRef = useRef(onEvent);
  useEffect(() => {
    cbRef.current = onEvent;
  });

  useEffect(() => {
    const es = new EventSource(`/api/events/stream`);
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data);
        cbRef.current(payload);
      } catch {
        // ignore parse errors
      }
    };
    return () => es.close();
  }, [channel]);
}
