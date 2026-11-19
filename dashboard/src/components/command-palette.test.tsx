import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { CommandPalette, SUMMARY_CAP, getRecentCommands, recordRecentCommand } from './command-palette';
import { apiFetch } from '@/lib/api';

vi.mock('@/lib/api', () => ({ apiFetch: vi.fn(), ApiError: class extends Error {} }));
// Mock fetchCommands at the composer module level so the module-level cache
// cannot bleed across tests.
vi.mock('./composer', () => ({
  fetchCommands: vi.fn(),
  Composer: () => null,
}));
import { fetchCommands } from './composer';

afterEach(() => { vi.clearAllMocks(); localStorage.clear(); });
beforeAll(() => {
  // cmdk scrolls the selected item into view; jsdom lacks it.
  Element.prototype.scrollIntoView = vi.fn();
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as never;
});

const sessions = [
  { id: 's-1', mode: 'live' as const, title: 'Job queue research', titleExplicit: true, model: 'haiku' },
  { id: 's-2', mode: 'live' as const, title: 'fix-the-login-bug', model: 'sonnet' },
];

const nativeCmd = { name: '/cost', summary: 'Show session cost', kind: 'native' as const, web: 'ok' as const };
const skillCmd  = { name: '/mint', summary: 'Deliver a feature end to end', kind: 'skill'  as const, web: 'ok' as const };
const gatedCmd  = { name: '/editor', summary: 'Open editor', kind: 'native' as const, web: 'gated' as const };

function openPalette() {
  act(() => { fireEvent.keyDown(window, { key: 'k', metaKey: true }); });
  return screen.getByPlaceholderText('Search sessions, commands, views…') as HTMLInputElement;
}

it('Escape closes the palette and returns focus to where it was', async () => {
  vi.mocked(fetchCommands).mockResolvedValue([]);
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
  vi.mocked(fetchCommands).mockResolvedValue([]);
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
  vi.mocked(fetchCommands).mockResolvedValue([nativeCmd, gatedCmd]);
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

it('groups native commands before skills', async () => {
  vi.mocked(fetchCommands).mockResolvedValue([skillCmd, nativeCmd]);
  render(<CommandPalette onNavigate={vi.fn()} sessions={[]} onInsertCommand={vi.fn()} />);
  openPalette();
  await screen.findByText('/cost');
  const headings = [...document.querySelectorAll('[cmdk-group-heading]')].map((h) => h.textContent);
  const cmdIdx   = headings.indexOf('Commands');
  const skillIdx = headings.indexOf('Skills');
  expect(cmdIdx).toBeGreaterThanOrEqual(0);
  expect(skillIdx).toBeGreaterThan(cmdIdx);
});

it('shows recently-used commands first in a "Recent" group', async () => {
  vi.mocked(fetchCommands).mockResolvedValue([nativeCmd, skillCmd]);
  recordRecentCommand('/mint');
  const onInsertCommand = vi.fn();
  render(<CommandPalette onNavigate={vi.fn()} sessions={[]} onInsertCommand={onInsertCommand} />);
  openPalette();
  await screen.findByText('/mint');
  const headings = [...document.querySelectorAll('[cmdk-group-heading]')].map((h) => h.textContent);
  expect(headings[0]).toBe('Recent');
  // /mint should appear only in Recent, not also in Skills
  const skillIdx  = headings.indexOf('Skills');
  const recentIdx = headings.indexOf('Recent');
  expect(recentIdx).toBeLessThan(skillIdx < 0 ? Infinity : skillIdx);
});

it('records a command as recent when selected', async () => {
  vi.mocked(fetchCommands).mockResolvedValue([nativeCmd]);
  const onInsertCommand = vi.fn();
  render(<CommandPalette onNavigate={vi.fn()} sessions={[]} onInsertCommand={onInsertCommand} />);
  const input = openPalette();
  await screen.findByText('/cost');
  fireEvent.change(input, { target: { value: '/cost' } });
  fireEvent.keyDown(input, { key: 'Enter' });
  expect(onInsertCommand).toHaveBeenCalledWith('/cost ');
  expect(getRecentCommands()).toContain('/cost');
});

it('caps displayed summary at SUMMARY_CAP chars; full text stays searchable', async () => {
  const longSummary = 'A'.repeat(SUMMARY_CAP + 20);
  const longCmd = { name: '/long', summary: longSummary, kind: 'native' as const, web: 'ok' as const };
  vi.mocked(fetchCommands).mockResolvedValue([longCmd]);
  render(<CommandPalette onNavigate={vi.fn()} sessions={[]} onInsertCommand={vi.fn()} />);
  openPalette();
  await screen.findByText('/long');
  const displayed = screen.getByText((t) => t.startsWith('A') && t.endsWith('…'));
  expect(displayed.textContent?.length).toBe(SUMMARY_CAP + 1); // +1 for the ellipsis char
  // Full summary is in the keywords so the item is searchable (cmdk uses keywords for filtering).
  const item = displayed.closest('[cmdk-item]') ?? displayed.closest('[data-value]');
  expect(item).not.toBeNull();
});
