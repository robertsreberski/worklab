import { render } from "preact";
import { App } from "./App.jsx";
import { installMobileViewportMetrics } from "./lib/mobileViewport.js";

installMobileViewportMetrics();
render(<App />, document.getElementById("app"));
