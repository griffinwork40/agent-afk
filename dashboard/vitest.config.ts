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
    // Belt-and-suspenders: any individual test taking > 30 s is almost
    // certainly blocked on a heavy module init rather than test logic.
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src'),
    },
  },
});
