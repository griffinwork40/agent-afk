import { fireEvent, render, screen } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { SessionContent } from './session-content';
import { SessionStatusBadge, classifySession } from './session-status-badge';
import { MobileSidebar } from './mobile-sidebar';

const empty = { loading: false, sessions: [], selectedSession: undefined, items: [], cmdItems: [], totals: { costUsd: 0, turns: 0, durationMs: 0 }, status: 'open', turnActive: false };

it('welcomes first use with a real new-chat action and pending state', () => {
  const start = vi.fn();
  const { rerender } = render(<SessionContent {...empty} onNewSession={start} />);
  expect(screen.queryByText('afk web')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'New chat' }));
  expect(start).toHaveBeenCalledOnce();
  rerender(<SessionContent {...empty} onNewSession={start} starting />);
  expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
});

it('offers four editable starting prompts rather than sending them automatically', () => {
  const suggest = vi.fn();
  render(<SessionContent {...empty} selectedSession={{ id: 'one', mode: 'live' }} onSuggest={suggest} />);
  expect(screen.getAllByRole('button')).toHaveLength(4);
  fireEvent.click(screen.getByRole('button', { name: 'Explore this project' }));
  expect(suggest).toHaveBeenCalledWith('Give me a concise overview of this project and its architecture.');
});

it('pulses only an explicitly running turn', () => {
  const { container, rerender } = render(<SessionStatusBadge status="active" />);
  expect(screen.getByText('Idle')).toBeTruthy();
  expect(container.querySelector('.animate-pulse')).toBeNull();
  rerender(<SessionStatusBadge status="active" running />);
  expect(screen.getByText('Running')).toBeTruthy();
  expect(container.querySelector('.animate-pulse')).toBeTruthy();
  rerender(<SessionStatusBadge status="completed" running />);
  expect(container.querySelector('.animate-pulse')).toBeNull();
});

it('makes the closed drawer inert and derives its width from its content', () => {
  const { container, rerender } = render(<MobileSidebar open={false} onClose={vi.fn()}><aside /></MobileSidebar>);
  const drawer = container.querySelector('[role="dialog"]')!;
  expect(drawer).toHaveAttribute('inert');
  expect(drawer).toHaveAttribute('aria-hidden', 'true');
  expect(drawer.className).toContain('w-max');
  rerender(<MobileSidebar open onClose={vi.fn()}><aside /></MobileSidebar>);
  expect(screen.getByRole('dialog')).not.toHaveAttribute('inert');
});

it('classifies an idle live session as Idle (active), not Done', () => {
  const live = { id: 'l', mode: 'live' } as Parameters<typeof classifySession>[0];
  expect(classifySession(live, new Set())).toBe('active');
  expect(classifySession(live, new Set(), new Set(['l']))).toBe('active');
  expect(classifySession({ id: 'r', mode: 'readonly' } as Parameters<typeof classifySession>[0], new Set(), new Set(['r']))).toBe('active');
  expect(classifySession({ id: 'r', mode: 'readonly' } as Parameters<typeof classifySession>[0], new Set())).toBe('completed');
});
