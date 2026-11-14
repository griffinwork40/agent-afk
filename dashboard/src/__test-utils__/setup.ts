import '@testing-library/jest-dom';
import { beforeEach, vi } from 'vitest';

beforeEach(() => {
  window.history.replaceState({}, '', '/');
  sessionStorage.clear();
});

// Global stub for @/lib/highlight so no test ever loads Shiki's JS regex engine
// or language grammars at test-time. Without this stub the createHighlighter()
// call in highlight.ts takes 60-120 s per worker in jsdom, reliably timing out
// the CI `test-dashboard` job (timeout-minutes: 10).
//
// Tests that need real token output (e.g. code-block.whitespace.test.tsx) supply
// their own vi.mock('@/lib/highlight', ...) before importing the module under
// test; Vitest hoists those file-local mocks above this global one, so they win.
vi.mock('@/lib/highlight', () => ({
  highlight: async (code: string) => ({
    fg: '#e1e4e8',
    bg: '#24292e',
    lines: code.split('\n').map((line: string) =>
      line ? [{ content: line, color: '#e1e4e8' }] : []
    ),
  }),
  preloadLang: () => Promise.resolve(),
}));
