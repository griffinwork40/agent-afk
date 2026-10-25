import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { CommandPalette } from './command-palette';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), ApiError: class extends Error {} }));
afterEach(() => vi.clearAllMocks());
beforeAll(() => {
  // cmdk scrolls the selected item into view; jsdom lacks it.
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

const sessions = [
  { id: 's-1', mode: 'live' as const, title: 'Job queue research', titleExplicit: true, model: 'haiku' },
  { id: 's-2', mode: 'live' as const, title: 'fix-the-login-bug', model: 'sonnet' },
];

function openPalette() {
  act(() => { fireEvent.keyDown(window, { key: 'k', metaKey: true }); });
  return screen.getByPlaceholderText('Search sessions, commands, views…') as HTMLInputElement;
}

it('Escape closes the palette and returns focus to where it was', async () => {
  render(<><textarea data-testid="composer-textarea" /><CommandPalette onNavigate={vi.fn()} sessions={sessions} /></>);
  const ta = screen.getByTestId('composer-textarea');
  ta.focus();
  const input = openPalette();
  expect(document.activeElement).toBe(input);
  fireEvent.keyDown(input, { key: 'Escape' });
  expect(screen.queryByTestId('command-palette')).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(ta));
});

it('fuzzy-filters sessions by title; Enter navigates to the session', async () => {
  const onSelectSession = vi.fn();
  render(<CommandPalette onNavigate={vi.fn()} sessions={sessions} onSelectSession={onSelectSession} />);
  const input = openPalette();
  const headings = [...document.querySelectorAll('[cmdk-group-heading]')].map((h) => h.textContent);
  expect(headings).toEqual(['Sessions', 'Navigation']);
  fireEvent.change(input, { target: { value: 'job queue' } });
  await waitFor(() => expect(screen.queryByText('Fix the login bug')).toBeNull());
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onSelectSession).toHaveBeenCalledWith('s-1');
  expect(screen.queryByTestId('command-palette')).toBeNull();
});

it('lists slash commands and inserts the selected one; arrows move the selection', async () => {
  vi.mocked(apiFetch).mockResolvedValue({ commands: [
    { name: '/cost', summary: 'Show session cost', kind: 'native', web: 'ok' },
    { name: '/editor', summary: 'Open editor', kind: 'native', web: 'gated' },
  ] });
  const onInsertCommand = vi.fn();
  const onNavigate = vi.fn();
  render(<CommandPalette onNavigate={onNavigate} sessions={sessions} onInsertCommand={onInsertCommand} />);
  const input = openPalette();
  await screen.findByText('/cost');
  expect(screen.queryByText('/editor')).toBeNull(); // gated on the web
  fireEvent.change(input, { target: { value: '/cost' } });
  await waitFor(() => expect(screen.queryByText('Job queue research')).toBeNull());
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onInsertCommand).toHaveBeenCalledWith('/cost ');
  // Navigation via arrows.
  const again = openPalette();
  fireEvent.change(again, { target: { value: 'memory' } });
  fireEvent.keyDown(again, { key: 'ArrowDown' });
  fireEvent.keyDown(again, { key: 'ArrowUp' });
  fireEvent.keyDown(again, { key: 'Enter' });
  expect(onNavigate).toHaveBeenCalledWith('memory');
});
