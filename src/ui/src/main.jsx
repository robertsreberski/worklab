import { render } from "preact";
import { App } from "./App.jsx";
import { installMobileViewportMetrics } from "./lib/mobileViewport.js";
import { installViewportDebugOverlay } from "./lib/viewportDebugOverlay.js";

installMobileViewportMetrics();
installViewportDebugOverlay();
render(<App />, document.getElementById("app"));

// Register the precaching service worker in production so the PWA can load
// the hashed Vite bundle from cache on cellular and after offline relaunches.
if (import.meta.env.PROD && typeof navigator !== "undefined" && "serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Registration is best-effort; ignore failures so the UI still boots.
    });
  });
}
