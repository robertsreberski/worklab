import { render } from "preact";
import { App } from "./App.jsx";
import { installMobileViewportMetrics } from "./lib/mobileViewport.js";
import { installViewportDebugOverlay } from "./lib/viewportDebugOverlay.js";

installMobileViewportMetrics();
installViewportDebugOverlay();
render(<App />, document.getElementById("app"));
