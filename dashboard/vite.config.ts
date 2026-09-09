import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
        target: 'http://127.0.0.1:4141',
        changeOrigin: true,
      },
    },
  },
});
