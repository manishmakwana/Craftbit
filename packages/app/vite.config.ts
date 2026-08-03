import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Served from the domain root in dev/preview; the Pages deploy sets
  // VITE_BASE=/<repo>/ so assets resolve under the project subpath.
  base: process.env.VITE_BASE || "/",
  plugins: [react()],
  worker: {
    format: "es",
  },
  optimizeDeps: {
    exclude: ["opencascade.js"],
  },
  build: {
    target: "es2022",
  },
  server: {
    // Needed to run behind a forwarding proxy (GitHub Codespaces, Gitpod, etc.):
    // Vite binds to all interfaces and skips its default Host-header allowlist,
    // since the forwarded hostname (e.g. *.app.github.dev) isn't "localhost".
    host: true,
    allowedHosts: true,
  },
});
