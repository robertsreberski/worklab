import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import { VitePWA } from "vite-plugin-pwa";
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
  plugins: [
    preact(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src/service-worker",
      filename: "sw.js",
      injectRegister: null,
      manifest: false,
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,woff2}"],
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
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
