import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CodeBlock } from './code-block';
import { FullToolOutput } from './full-tool-output';
import { TopologyNode } from './topology-node';
import { TopologySpine } from './topology-spine';
import { groupIntoSpineSlots } from './transcript-spine';
import { ToolCallCard } from './tool-call-card';
import { ToolSummaryCwd } from '@/lib/tool-summary-context';
import type { SpineNode } from '@/lib/topology-types';

vi.mock('shiki', () => ({ createHighlighter: vi.fn().mockRejectedValue(new Error('use fallback')) }));
const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
const node: SpineNode = { id: '1', kind: 'tool', label: 'read_file', category: 'read', status: 'ok', preview: '/repo/a.ts', children: [], isActive: false, seq: 0 };

describe('transcript density', () => {
  it('collapses code after 25 lines but copies everything', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    const { container } = render(<CodeBlock code={lines} />);
    expect(container.querySelector('pre')?.textContent).not.toContain('line 40');
    fireEvent.click(screen.getByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith(lines);
    fireEvent.click(screen.getByRole('button', { name: 'Show 15 more lines' }));
    expect(container.querySelector('pre')?.textContent).toContain('line 40');
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(container.querySelector('pre')?.textContent).not.toContain('line 40');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy());
  });
  it('collapses and expands tool output', () => {
    const { container } = render(<FullToolOutput preview={lines} />);
    expect(container.querySelector('pre')?.textContent).not.toContain('line 40');
    fireEvent.click(screen.getByRole('button', { name: 'Show 15 more lines' }));
    expect(container.querySelector('pre')?.textContent).toContain('line 40');
  });
  it('omits notice-only execution blocks', () => {
    const { container } = render(<TopologySpine nodes={[]} />);
    expect(container.textContent).toBe('');
    expect(groupIntoSpineSlots([{ kind: 'notice', id: 'notice', text: 'Done' }])).toEqual([]);
  });
  it('shows distinct relative paths and explicit success/error labels in both renderers', () => {
    render(<ToolSummaryCwd.Provider value="/repo"><TopologyNode node={node} /><TopologyNode node={{ ...node, id: '2', status: 'error', preview: '/repo/b.ts' }} /><ToolCallCard name="bash" inputPreview={'echo first\necho second'} status="ok" /></ToolSummaryCwd.Provider>);
    expect(screen.getByText('a.ts')).toBeTruthy();
    expect(screen.getByText('b.ts')).toBeTruthy();
    expect(screen.getByText('✓ Done')).toBeTruthy();
    expect(screen.getByText('! Error')).toBeTruthy();
    expect(screen.getByText('echo first')).toBeTruthy();
  });
  it('expands a nested agent with Enter and Space', () => {
    render(<TopologyNode node={{ ...node, kind: 'agent', children: [{ ...node, id: 'child', preview: '/repo/child.ts' }] }} />);
    const button = screen.getByRole('button');
    fireEvent.keyDown(button, { key: 'Enter' });
    expect(button).toHaveAttribute('aria-expanded', 'true');
    fireEvent.keyDown(button, { key: ' ' });
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });
});
