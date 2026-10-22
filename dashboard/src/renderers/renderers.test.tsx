import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { getBlockRenderer } from '@/lib/block-renderer-registry';
import type { CommandOutputBlock } from '@/types/command-wire';

const fallback = { text: 'plain fallback', ansi: 'ansi fallback' };
const show = (block: CommandOutputBlock) => render(getBlockRenderer(block.kind ?? 'text')(block));

describe('structured command renderers', () => {
  it('renders an accessible, keyboard-scrollable table with caption and column headers', () => {
    show({ ...fallback, kind: 'table', title: 'Costs', columns: ['Model', 'Cost'], rows: [['sonnet', '$1'], ['opus', '$2']] });
    const region = screen.getByRole('region', { name: 'Costs' });
    expect(region).toHaveClass('overflow-x-auto');
    expect(region).toHaveAttribute('tabindex', '0');
    const table = screen.getByRole('table', { name: 'Costs' });
    expect(within(table).getAllByRole('columnheader')).toHaveLength(2);
    expect(within(table).getByRole('columnheader', { name: 'Model' })).toHaveAttribute('scope', 'col');
    expect(within(table).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['sonnet', '$1', 'opus', '$2']);
  });

  it('renders key/value pairs as a definition list', () => {
    const { container } = show({ ...fallback, kind: 'keyValue', title: 'Session', entries: [{ key: 'Model', value: 'sonnet' }, { key: 'Turns', value: '3' }] });
    expect(screen.getByRole('heading', { name: 'Session' })).toBeInTheDocument();
    expect([...container.querySelectorAll('dt')].map((el) => el.textContent)).toEqual(['Model', 'Turns']);
    expect([...container.querySelectorAll('dd')].map((el) => el.textContent)).toEqual(['sonnet', '3']);
  });

  it('renders safe diff text with semantic color tokens and preserves newlines', () => {
    const diff = '--- a/file\n+++ b/file\n@@ -1 +1 @@\n-old\n+<img src=x onerror=alert(1)>\n unchanged\n';
    const { container } = show({ ...fallback, kind: 'diff', fileName: 'file.ts', diff });
    expect(screen.getByRole('heading', { name: 'file.ts' })).toBeInTheDocument();
    expect(container.querySelector('code')?.textContent).toBe(diff);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('-old')).toHaveClass('text-status-failed');
    expect(screen.getByText('+<img src=x onerror=alert(1)>')).toHaveClass('text-status-done');
    expect(screen.getByText('+++ b/file')).not.toHaveClass('text-status-done');
    expect(screen.getByText('--- a/file')).not.toHaveClass('text-status-failed');
  });

  it('renders list title, items and optional descriptions', () => {
    show({ ...fallback, kind: 'list', title: 'Tools', items: [{ text: 'read_file', description: 'Reads text' }, { text: 'bash' }] });
    expect(screen.getByRole('heading', { name: 'Tools' })).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Reads text')).toHaveClass('text-muted-foreground');
  });

  it('renders a safe external link', () => {
    show({ ...fallback, kind: 'link', label: 'Docs', url: 'https://example.com/docs' });
    const link = screen.getByRole('link', { name: 'Docs' });
    expect(link).toHaveAttribute('href', 'https://example.com/docs');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it.each(['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'mailto:someone@example.com', 'not a url'])('does not link unsafe URL %s', (url) => {
    show({ ...fallback, kind: 'link', label: 'Unsafe', url });
    expect(screen.queryByRole('link')).toBeNull();
    expect(screen.getByText('plain fallback')).toBeInTheDocument();
  });

  it.each<CommandOutputBlock>([
    { ...fallback, kind: 'table', columns: [], rows: [] },
    { ...fallback, kind: 'keyValue', entries: [] },
    { ...fallback, kind: 'list', items: [] },
    { ...fallback, kind: 'diff', diff: '' },
  ])('handles empty $kind blocks', (block) => {
    expect(show(block).container.firstChild).toBeTruthy();
  });

  it.each(['table', 'keyValue', 'diff', 'list', 'link'])('falls back when a %s renderer receives a different block', (kind) => {
    render(getBlockRenderer(kind)(fallback));
    expect(screen.getByText('plain fallback')).toBeInTheDocument();
  });
});
