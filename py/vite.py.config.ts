// Builds the unchanged React UI for the Python desktop build into py/web.
// The two Tauri modules are replaced by py/shim, so src/ is never edited:
//   corepack pnpm exec vite build --config py/vite.py.config.ts
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const here = (file: string) => fileURLToPath(new URL(file, import.meta.url));
const repoRoot = here("..");

export default defineConfig({
  root: repoRoot,
  // py/ has no .env, so the repo's real settings files never reach the bundle.
  envDir: here("."),
  plugins: [react()],
  resolve: {
    alias: [
      { find: /^@tauri-apps\/api\/core$/, replacement: here("./shim/core.ts") },
      { find: /^@tauri-apps\/api\/event$/, replacement: here("./shim/event.ts") },
    ],
  },
  build: {
    outDir: here("./web"),
    emptyOutDir: true,
  },
  clearScreen: false,
});
