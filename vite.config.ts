import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// One config for the dev server, the tests and the build. The build lands in backend/web,
// which the Python server serves to the pywebview window.
export default defineConfig({
  plugins: [react()],
  // This folder has no .env, so the repo's real settings files never reach the bundle.
  envDir: "./.no-env",
  server: { port: 1420, strictPort: true },
  optimizeDeps: { entries: ["index.html"] },
  build: { outDir: "backend/web", emptyOutDir: true },
  clearScreen: false,
  test: {
    environment: "jsdom",
    setupFiles: ["./src/shared/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
