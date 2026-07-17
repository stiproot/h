import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";

// Frontend-only SPA over the h runtime's read surfaces. The dev server proxies
// keep every fetch same-origin (no CORS, no keys in the client):
//   /svc/* → workflow-svc :8003  (workflow/watch/chain/cron registries)
//   /obs/* → obs-mcp     :8013  (run-ledger JSON routes)
// The compose nginx sibling mirrors the same two rules in production.
export default defineConfig({
  plugins: [vue()],
  base: "./",
  server: {
    proxy: {
      "/svc": {
        target: "http://localhost:8003",
        rewrite: (p) => p.replace(/^\/svc/, ""),
      },
      "/obs": {
        target: "http://localhost:8013",
        rewrite: (p) => p.replace(/^\/obs/, ""),
      },
    },
  },
});
