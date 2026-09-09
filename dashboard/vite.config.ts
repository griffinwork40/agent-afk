import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

const WEB_SERVER_ORIGIN = 'http://127.0.0.1:4141';

/** Escape an operator-supplied token before placing it in a quoted attribute. */
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    // Dev-only: replace the __AFK_WEB_TOKEN__ placeholder with the real token
    // so the dashboard can authenticate against a running `afk web` backend.
    // Set AFK_WEB_TOKEN in the environment to match the backend's token.
    {
      name: 'afk-dev-token',
      apply: 'serve',
      transformIndexHtml(html) {
        const token = process.env['AFK_WEB_TOKEN'] ?? '';
        return html.replace('__AFK_WEB_TOKEN__', escapeHtmlAttribute(token));
      },
    },
  ],
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
  build: {
    // Output directly into the web-ui-assets directory that static-assets.ts
    // serves. The existing build pipeline copies this to dist/ for publishing.
    outDir: resolve(__dirname, '../src/web-ui-assets'),
    emptyOutDir: true,
    // Deterministic asset names for CSP + cache-busting
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  // Dev server proxies API calls to the existing web-server
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: WEB_SERVER_ORIGIN,
        changeOrigin: true,
        configure(proxy) {
          // The backend's CSRF check requires mutating requests to originate
          // from the backend itself rather than Vite's development origin.
          proxy.on('proxyReq', (proxyReq, req) => {
            if (req.method !== 'GET') proxyReq.setHeader('Origin', WEB_SERVER_ORIGIN);
          });
        },
      },
    },
  },
});
