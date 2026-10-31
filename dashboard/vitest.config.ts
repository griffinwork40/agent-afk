import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__test-utils__/setup.ts'],
    css: false,
    // Belt-and-suspenders: any individual test taking > 30 s is almost certainly
    // blocked on Shiki grammar loading rather than testing logic. Fail fast so
    // the reporter names the culprit instead of silently timing out the whole job.
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
});
