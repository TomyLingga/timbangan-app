import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import type { Plugin } from "vite";

/**
 * The Content Security Policy of the window, as a meta tag. The built program loads only its own files. The
 * development server needs inline styles and scripts (React refresh) and its websocket, so it gets a looser policy;
 * it is never shipped.
 */
function contentSecurityPolicy(): Plugin {
  const strict = [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' blob:",
    "font-src 'self'",
    "connect-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  const development = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob:",
    "font-src 'self'",
    "connect-src 'self' ws://localhost:*",
    "object-src 'none'",
    "base-uri 'none'",
  ].join("; ");
  return {
    name: "content-security-policy",
    transformIndexHtml(html, context) {
      const policy = context.server ? development : strict;
      return html.replace("<head>", `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
    },
  };
}

export default defineConfig({
  // dependencies of the main process (the native serial module among them) stay in node_modules and are
  // loaded at run time; electron-vite externalises them by default
  main: {},
  preload: {},
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    plugins: [react(), contentSecurityPolicy()],
    build: {
      // no data: URIs: every font and image is a file the policy allows as 'self'
      assetsInlineLimit: 0,
    },
  },
});
