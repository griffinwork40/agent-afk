import { describe, expect, it, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';

// Highlighter stub: one token per line with its leading indentation intact.
vi.mock('@/lib/highlight', () => ({
  preloadLang: () => Promise.resolve(),
  highlight: async (code: string) => ({
    fg: '#e1e4e8', bg: '#24292e',
    lines: code.split('\n').map((line) => (line ? [{ content: line, color: '#e1e4e8' }] : [])),
  }),
}));

import { CodeBlock } from './code-block';

describe('CodeBlock indentation', () => {
  it('keeps leading whitespace in highlighted code (white-space: pre on the token container)', async () => {
    const code = 'def f(x):\n    if x:\n        return 1\n    return 0';
    const { container } = render(<CodeBlock code={code} language="python" />);
    await waitFor(() => expect(container.querySelector('[aria-label="python code block"]')).not.toBeNull());
    const region = container.querySelector('[aria-label="python code block"]') as HTMLElement;
    expect(region.className).toMatch(/\bwhitespace-pre\b/);
    expect(region.textContent).toContain('        return 1');
  });
});
