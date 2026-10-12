/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const apiProxyTarget = process.env.VITE_API_PROXY_TARGET ?? "http://127.0.0.1:8001";

export default defineConfig({
  plugins: [react()],
  test: {
    // The drawing module's SVG import/export uses DOMParser.
    environment: "jsdom",
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: {
      // The drawing tool shows the stamp-pack template from docs/stamp-packs/
      // (imported with ?raw), so the docs and the app never drift apart.
      allow: [".", "../../docs/stamp-packs"],
    },
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
});
