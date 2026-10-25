import { render, screen } from '@testing-library/react';
import { expect, it } from 'vitest';
import { SessionContent, WorkspaceChips } from './session-content';

const totals = { costUsd: 0, durationMs: 0, turns: 0 } as never;

it('shows the folder (repo name) and model chips on the empty-session welcome screen', () => {
  const session = { id: 's1', mode: 'live' as const, cwd: '/Users/me/code/agent-afk' };
  render(<SessionContent loading={false} sessions={[session]} selectedSession={session} items={[]} cmdItems={[]}
    totals={totals} status="open" turnActive={false} currentModel="haiku" />);
  expect(screen.getByText('What can we work on?')).toBeTruthy();
  expect(screen.getByTestId('folder-chip').textContent).toBe('agent-afk');
  expect(screen.getByTestId('model-chip').textContent).toBe('haiku');
});

it('falls back to the server cwd when the session row has none yet', () => {
  const session = { id: 's1', mode: 'live' as const };
  render(<SessionContent loading={false} sessions={[session]} selectedSession={session} items={[]} cmdItems={[]}
    totals={totals} status="open" turnActive={false} serverCwd="/srv/repo/" />);
  expect(screen.getByTestId('folder-chip').textContent).toBe('repo');
});

it('renders nothing without a folder or model', () => {
  const { container } = render(<WorkspaceChips />);
  expect(container.innerHTML).toBe('');
});
