import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CommandOutput } from './command-output';
import type { CommandOutputBlock } from '@/types/command-wire';

const block = (text: string, ansi?: string): CommandOutputBlock => ({
  text,
  ansi: ansi ?? text,
});

describe('CommandOutput', () => {
  it('renders command echo in the header', () => {
    render(<CommandOutput input="/help" blocks={[block('some output')]} />);
    expect(screen.getByText('/help')).toBeTruthy();
  });

  it('renders block text content', () => {
    render(<CommandOutput input="/cost" blocks={[block('Total: $0.01')]} />);
    expect(screen.getByText('Total: $0.01')).toBeTruthy();
  });

  it('renders multiple blocks in order', () => {
    render(
      <CommandOutput
        input="/tools"
        blocks={[block('Tool A'), block('Tool B'), block('Tool C')]}
      />,
    );
    expect(screen.getByText('Tool A')).toBeTruthy();
    expect(screen.getByText('Tool B')).toBeTruthy();
    expect(screen.getByText('Tool C')).toBeTruthy();
  });

  it('has a copy button', () => {
    render(<CommandOutput input="/help" blocks={[block('output')]} />);
    expect(screen.getByRole('button', { name: /copy/i })).toBeTruthy();
  });

  it('has accessible region label', () => {
    render(<CommandOutput input="/debug" blocks={[block('debug info')]} />);
    expect(screen.getByRole('region', { name: /output for \/debug/i })).toBeTruthy();
  });

  it('copies plain text for mixed blocks rather than ANSI or rendered markup', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    render(<CommandOutput input="/mixed" blocks={[
      block('legacy plain', '\x1b[31mlegacy ansi\x1b[0m'),
      { kind: 'table', columns: ['Column'], rows: [['rich cell']], text: 'table plain', ansi: 'table ansi' },
      { kind: 'keyValue', entries: [], text: 'key value plain', ansi: '' },
      { kind: 'diff', diff: '+rich diff', text: 'diff plain', ansi: '' },
      { kind: 'list', items: [], text: 'list plain', ansi: '' },
      { kind: 'link', label: 'Docs', url: 'https://example.com', text: 'link plain', ansi: '' },
    ]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy command output' }));
    await waitFor(() => expect(screen.getByText('Copied')).toBeInTheDocument());
    expect(writeText).toHaveBeenCalledWith('legacy plain\ntable plain\nkey value plain\ndiff plain\nlist plain\nlink plain');
  });

  it('uses plain fallback for a future wire kind, not its ANSI field', () => {
    // A newer server may return a kind this client does not yet know.
    const unknown = { kind: 'future', text: 'future fallback', ansi: 'do not display' } as unknown as CommandOutputBlock;
    render(<CommandOutput input="/future" blocks={[unknown]} />);
    expect(screen.getByText('future fallback')).toBeInTheDocument();
    expect(screen.queryByText('do not display')).toBeNull();
  });

  it('falls back to plain text for a malformed structured block', () => {
    const malformed = { kind: 'table', text: 'malformed fallback', ansi: '' } as CommandOutputBlock;
    render(<CommandOutput input="/malformed" blocks={[malformed]} />);
    expect(screen.getByText('malformed fallback')).toBeInTheDocument();
  });

  it('renders empty blocks without crashing', () => {
    const { container } = render(<CommandOutput input="/noop" blocks={[]} />);
    expect(container.firstChild).toBeTruthy();
  });
});
