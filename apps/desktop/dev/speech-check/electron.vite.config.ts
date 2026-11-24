// Build of the speech check (see dev/speech-check.mts): its own main process and page, with the program's real
// preload, API client, audio module and speech queue. The output goes to the folder in SPEECH_CHECK_OUT, never to
// out/, so a build of the program is not touched.
import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import { contentSecurityPolicy } from "../../electron.vite.config";

const out = process.env.SPEECH_CHECK_OUT;
if (!out) throw new Error("SPEECH_CHECK_OUT is not set.");
const app = resolve(__dirname, "../..");

export default defineConfig({
  main: {
    build: { outDir: resolve(out, "main"), emptyOutDir: true, rollupOptions: { input: { index: resolve(__dirname, "main.ts") } } },
  },
  preload: {
    build: { outDir: resolve(out, "preload"), emptyOutDir: true, rollupOptions: { input: { index: resolve(app, "src/preload/index.ts") } } },
  },
  renderer: {
    root: __dirname,
    plugins: [contentSecurityPolicy()],
    build: { outDir: resolve(out, "renderer"), emptyOutDir: true, assetsInlineLimit: 0, rollupOptions: { input: resolve(__dirname, "index.html") } },
  },
});
