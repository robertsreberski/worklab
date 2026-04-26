import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const rawApiHost = process.env.WORKLAB_HOST;
const apiClientHost = !rawApiHost || rawApiHost === "0.0.0.0" || rawApiHost === "::"
  ? "127.0.0.1"
  : rawApiHost;
const apiHost = apiClientHost.includes(":") && !apiClientHost.startsWith("[")
  ? `[${apiClientHost}]`
  : apiClientHost;
const apiPort = process.env.WORKLAB_PORT || "7878";
const uiPort = Number(process.env.WORKLAB_UI_PORT || "5173");

export default defineConfig({
  root: resolve(__dirname),
  plugins: [preact()],
  build: {
    outDir: resolve(__dirname, "dist"),
    emptyOutDir: true,
  },
  server: {
    port: uiPort,
    proxy: {
      "/api": `http://${apiHost}:${apiPort}`,
    },
  },
});
