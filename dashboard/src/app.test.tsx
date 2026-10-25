import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App } from './app';
import * as api from '@/lib/api';
import { clearCommandsCache } from './components/composer';

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

vi.mock('./hooks/use-sessions', () => ({
  useSessions: () => ({ sessions: [LIVE_SESSION], loading: false }),
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

const MODELS_RESPONSE = {
  models: [
    { id: 'haiku',  label: 'haiku · Claude Haiku 5.5' },
    { id: 'sonnet', label: 'sonnet · Claude Sonnet 4.6' },
    { id: 'medium', label: 'medium · Claude Sonnet 4.6' },
    { id: 'opus',   label: 'opus · Claude Opus 5.5' },
  ],
  default: 'haiku',
};
const COMMANDS_RESPONSE = {
  commands: [
    { name: '/cost',   summary: 'Show cost',  kind: 'native', web: 'ok' },
    { name: '/clear',  summary: 'Clear',       kind: 'native', web: 'gated', gateReason: 'Not available on web' },
    { name: '/model',  summary: 'Switch model', kind: 'native', web: 'ok' },
    { name: '/review', summary: 'Review',      kind: 'skill',  web: 'ok' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  clearCommandsCache();
});

/** Render App, click the session card, and wait for the Composer textarea. */
async function renderAndSelect() {
  render(<App />);
  const spans = await screen.findAllByText('New session');
  const btn = spans[0]!.closest('button') ?? spans[0]!;
  fireEvent.click(btn);
  await screen.findByRole('textbox', {}, { timeout: 2000 });
}

// ---------------------------------------------------------------------------
// New session includes model
// ---------------------------------------------------------------------------

describe('App — new session honors server model', () => {
  it('omits model until the user chooses one', async () => {
    vi.mocked(api.apiFetch).mockResolvedValue({ session: { id: 'new-sess' } });

    render(<App />);
    const newBtn = screen.getAllByTitle('Start a new chat')[0]!;
    fireEvent.click(newBtn);

    await waitFor(() => {
      const calls = vi.mocked(api.apiFetch).mock.calls;
      const sessionCall = calls.find(
        (c) => String(c[0]) === '/api/sessions' &&
               (c[1] as { method?: string })?.method === 'POST',
      );
      expect(sessionCall).toBeTruthy();
      const body = JSON.parse(
        (sessionCall![1] as { body?: string })?.body ?? '{}',
      ) as { model?: string };
      expect(body).not.toHaveProperty('model');
    });
  });
});

// ---------------------------------------------------------------------------
// Integration: /cost → POST /commands, output appears in transcript
// ---------------------------------------------------------------------------

describe('App integration — /cost routes to /commands and shows output', () => {
  it('typing /cost + submit → POST to /commands, output text in DOM', async () => {
    const cmdResponse = {
      blocks: [{ kind: 'text', text: '$0.0042 total', ansi: '$0.0042 total' }],
      control: { kind: 'continue' },
    };
    vi.mocked(api.apiFetch)
      .mockResolvedValueOnce(MODELS_RESPONSE)    // /api/models (ModelSelector on mount)
      .mockResolvedValueOnce(COMMANDS_RESPONSE)  // /api/commands (fetchCommands on '/')
      .mockResolvedValueOnce(cmdResponse);        // POST /sessions/sess-1/commands

    await renderAndSelect();
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: '/cost ' } });
    fireEvent.keyDown(ta, { key: 'Enter' });

    await waitFor(() => {
      const calls = vi.mocked(api.apiFetch).mock.calls;
      expect(calls.some((c) => String(c[0]).includes('/sessions/'))).toBe(true);
    }, { timeout: 3000 });

    await waitFor(() => {
      expect(screen.getByText('$0.0042 total')).toBeTruthy();
    }, { timeout: 3000 });
  });
});

// ---------------------------------------------------------------------------
// Integration: /clear → gate reason notice, no POST
// ---------------------------------------------------------------------------

describe('App integration — /clear shows gate reason, no network call', () => {
  it('typing /clear + submit shows gateReason notice and no session POST', async () => {
    vi.mocked(api.apiFetch)
      .mockResolvedValueOnce(MODELS_RESPONSE)    // /api/models
      .mockResolvedValueOnce(COMMANDS_RESPONSE); // /api/commands

    await renderAndSelect();
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: '/clear ' } });
    fireEvent.keyDown(ta, { key: 'Enter' });

    await waitFor(() => {
      expect(screen.getByText('Not available on web')).toBeTruthy();
    }, { timeout: 3000 });

    const calls = vi.mocked(api.apiFetch).mock.calls;
    expect(calls.every((c) => !String(c[0]).includes('/sessions/'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Integration: /nope → POST /commands → 404 → "Did you mean" notice
// ---------------------------------------------------------------------------

describe('App integration — unknown command shows Did you mean', () => {
  it('/nope → POST /commands → 404 → toast with suggestion', async () => {
    const { ApiError } = await import('@/lib/api');
    const errBody = { error: 'unknown_command', message: 'not found', suggestion: '/cost' };
    vi.mocked(api.apiFetch)
      .mockResolvedValueOnce(MODELS_RESPONSE)   // /api/models
      .mockResolvedValueOnce(COMMANDS_RESPONSE) // /api/commands
      .mockRejectedValueOnce(new ApiError(404, JSON.stringify(errBody), errBody));

    await renderAndSelect();
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: '/nope ' } });
    fireEvent.keyDown(ta, { key: 'Enter' });

    await waitFor(() => {
      const calls = vi.mocked(api.apiFetch).mock.calls;
      expect(calls.some((c) => String(c[0]).includes('/sessions/'))).toBe(true);
    }, { timeout: 3000 });

    await waitFor(() => {
      expect(screen.getByText(/Did you mean/i)).toBeTruthy();
    }, { timeout: 3000 });
  });
});

// ---------------------------------------------------------------------------
// Integration: /review x → POST /prompt (skill route)
// ---------------------------------------------------------------------------

describe('App integration — /review routes to /prompt (skill)', () => {
  it('typing /review x + submit → POST to /prompt', async () => {
    vi.mocked(api.apiFetch)
      .mockResolvedValueOnce(MODELS_RESPONSE)   // /api/models
      .mockResolvedValueOnce(COMMANDS_RESPONSE) // /api/commands
      .mockResolvedValueOnce({});                // /prompt

    await renderAndSelect();
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: '/review some-pr' } });
    fireEvent.keyDown(ta, { key: 'Enter' });

    await waitFor(() => {
      const calls = vi.mocked(api.apiFetch).mock.calls;
      const promptCall = calls.find(
        (c) => String(c[0]).includes('/prompt') &&
               ((c[1] as { body?: string })?.body ?? '').includes('/review'),
      );
      expect(promptCall).toBeTruthy();
    }, { timeout: 3000 });
  });
});

// ---------------------------------------------------------------------------
// Regression: /model command response updates the ModelSelector value
//
// C2 enriches ChoiceDialog labels with resolved model names
// (e.g. "medium · Claude Sonnet 4.6"), making bare /sonnet/i match the wrong
// option. This test reproduces the *client-side* half: after the server
// returns session.model:'sonnet', the <select aria-label="Model"> must reflect
// that value — not stay on the default 'haiku' or show an unrelated alias.
// ---------------------------------------------------------------------------

describe('App regression — /model response updates ModelSelector', () => {
  it('select value matches session.model from command response', async () => {
    const cmdResponse = {
      blocks: [{ kind: 'text', text: '✓ Model switched to sonnet\n', ansi: '✓ Model switched to sonnet\n' }],
      control: { kind: 'continue' },
      session: { model: 'sonnet' },
    };
    vi.mocked(api.apiFetch)
      .mockResolvedValueOnce(MODELS_RESPONSE)    // /api/models (ModelSelector mount)
      .mockResolvedValueOnce(COMMANDS_RESPONSE)  // /api/commands (fetchCommands on '/')
      .mockResolvedValueOnce(cmdResponse);        // POST /sessions/sess-1/commands

    await renderAndSelect();
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: '/model sonnet' } });
    fireEvent.keyDown(ta, { key: 'Enter' });

    // Wait for the POST /commands to fire.
    await waitFor(() => {
      const calls = vi.mocked(api.apiFetch).mock.calls;
      expect(calls.some((c) => String(c[0]).includes('/commands') &&
        (c[1] as { method?: string })?.method === 'POST')).toBe(true);
    }, { timeout: 3000 });

    // The ModelSelector <select aria-label="Model"> must show 'sonnet'.
    await waitFor(() => {
      const sel = screen.getByRole('combobox', { name: 'Model' }) as HTMLSelectElement;
      expect(sel.value).toBe('sonnet');
    }, { timeout: 3000 });
  });
});
