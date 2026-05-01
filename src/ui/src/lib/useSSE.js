import { useEffect, useRef } from "preact/hooks";
import { closeSharedEventSourcesForTests, subscribeSharedEventSource } from "./sharedEventSource.js";

function streamUrl(channel) {
  return channel === "global" ? "/api/events/stream" : `/api/events/${encodeURIComponent(channel)}/stream`;
}

export function subscribeSSE(channel, onEvent) {
  return subscribeSharedEventSource(`sse:${channel}`, streamUrl(channel), onEvent);
}

export function closeSSEForTests() {
  closeSharedEventSourcesForTests();
}

export function useSSE(channel, onEvent) {
  const cbRef = useRef(onEvent);
  useEffect(() => {
    cbRef.current = onEvent;
  });

  useEffect(() => {
    return subscribeSSE(channel, (payload) => cbRef.current(payload));
  }, [channel]);
}
