import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from './app';
import * as api from '@/lib/api';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {
    status: number;
    body: Record<string, unknown> | undefined;
    constructor(status: number, message: string, body?: Record<string, unknown>) {
      super(`API ${status}: ${message}`);
      this.name = 'ApiError';
      this.status = status;
      this.body = body;
    }
  },
}));

// A live session so the Composer renders when selected
const LIVE_SESSION = { id: 'sess-1', mode: 'live' as const };
const PAST_SESSION = { id: 'old-1', mode: 'readonly' as const, title: 'ended-session' };
const RUNNING_ELSEWHERE = { id: 'repl-1', mode: 'readonly' as const, alive: true, title: 'running-in-repl' };

vi.mock('./hooks/use-sessions', () => ({
  useSessions: () => ({ sessions: [LIVE_SESSION, PAST_SESSION, RUNNING_ELSEWHERE], loading: false, refresh: vi.fn() }),
}));
vi.mock('./hooks/use-pending-approvals', () => ({
  usePendingApprovals: () => ({ approvals: [], pendingSessionIds: new Set() }),
}));
vi.mock('./hooks/use-transcript', () => ({
  useTranscript: () => ({
    items: [],
    totals: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0 },
    status: 'idle',
    turnActive: false,
    liveTurns: 0,
  }),
}));
vi.mock('./hooks/use-scroll-pin', () => ({
  useScrollPin: () => ({
    containerRef: { current: null },
    scrollToBottom: vi.fn(),
    isPinned: true,
    showScrollButton: false,
    hasNewContent: false,
    notifyNewContent: vi.fn(),
  }),
}));
vi.mock('./hooks/use-queue', () => ({
  useQueue: () => ({
    enqueue: vi.fn(),
    flush: vi.fn(),
    clear: vi.fn(),
    entries: [],
    moveItemUp: vi.fn(),
    moveItemDown: vi.fn(),
    removeItem: vi.fn(),
    editItem: vi.fn(),
  }),
}));


beforeEach(() => {
  vi.clearAllMocks();
});

describe('App — sidebar Resume uses the dedicated resume route', () => {
  it('POSTs /api/sessions/:id/resume and never borrows another session\'s command route', async () => {
    vi.mocked(api.apiFetch).mockImplementation(async (url: string) => {
      if (url === '/api/sessions/old-1/resume') return { session: { id: 'resumed-9' } };
      return { models: [], commands: [] };
    });
    render(<App />);
    const buttons = await screen.findAllByRole('button', { name: 'Resume this session' });
    fireEvent.click(buttons[0]!);
    await waitFor(() => {
      const urls = vi.mocked(api.apiFetch).mock.calls.map((c) => String(c[0]));
      expect(urls).toContain('/api/sessions/old-1/resume');
      expect(urls.some((u) => u.endsWith('/commands'))).toBe(false);
      expect(urls.filter((u) => u === '/api/sessions')).toHaveLength(0);
    });
  });

  it('shows a notice instead of failing silently when resume fails', async () => {
    vi.mocked(api.apiFetch).mockImplementation(async (url: string) => {
      if (url.endsWith('/resume')) throw new Error('No saved session: old-1');
      return { models: [], commands: [] };
    });
    render(<App />);
    const buttons = await screen.findAllByRole('button', { name: 'Resume this session' });
    fireEvent.click(buttons[0]!);
    expect(await screen.findByText(/Could not resume: No saved session: old-1/)).toBeTruthy();
  });

  it('does not offer Resume on a session that is running in another process', async () => {
    vi.mocked(api.apiFetch).mockResolvedValue({ models: [], commands: [] });
    render(<App />);
    // humanizeTitle converts slug titles: 'ended-session' -> 'Ended session'
    const ended = await screen.findAllByText('Ended session');
    const running = await screen.findAllByText('Running in repl');
    const resumeIn = (el: HTMLElement) =>
      el.closest('.group')?.querySelector('button[aria-label="Resume this session"]') ?? null;
    for (const el of ended) expect(resumeIn(el)).not.toBeNull();
    for (const el of running) expect(resumeIn(el)).toBeNull();
  });
});
