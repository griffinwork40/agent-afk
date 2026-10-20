/**
 * Tests for HandoffsView (dashboard/src/components/handoffs-view.tsx).
 *
 * Covers:
 *   - Loading state then empty-state message
 *   - Renders a pending handoff card with question message and sessionId
 *   - Choice buttons: clicking one POSTs the correct answer and removes the card
 *   - Confirm card (explicit type): Yes/No buttons send true/false
 *   - Confirm fallback (no type): Yes/No buttons
 *   - Free-text card: typing + submitting sends the string
 *   - 409 "no longer active" maps to a user-visible error message
 *   - API fetch error shows error banner
 *   - Pending count badge renders when handoffs > 0
 */

import {
  render,
  screen,
  fireEvent,
  waitFor,
  act,
} from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock apiFetch BEFORE importing the component.
// ---------------------------------------------------------------------------

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  getToken: vi.fn(() => 'test-token'),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'ApiError';
    }
  },
}));

import { apiFetch, ApiError } from '@/lib/api';
const { HandoffsView } = await import('./handoffs-view');

const mockApiFetch = apiFetch as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeHandoff(
  overrides: Partial<{
    taskId: string;
    sessionId: string;
    createdAt: string;
    questionMessage: string;
    questionType: string | undefined;
    questionChoices: string[] | undefined;
  }> = {},
) {
  return {
    taskId: overrides.taskId ?? 'q-1700000000000-abc',
    sessionId: overrides.sessionId ?? 'sess-abc',
    createdAt: overrides.createdAt ?? '2024-01-01T00:00:00.000Z',
    status: 'pending' as const,
    question: {
      message: overrides.questionMessage ?? 'Which environment?',
      type: overrides.questionType,
      choices: overrides.questionChoices,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Set up apiFetch to return a fixed handoffs list for GET and { ok: true }
 * for any POST.  The interval fires during the test but we set the mock
 * before render so every poll returns the same list — no side effects.
 */
function setupApiFetch(handoffs: ReturnType<typeof makeHandoff>[]) {
  mockApiFetch.mockImplementation(
    async (path: string, options?: RequestInit) => {
      const method = options?.method?.toUpperCase() ?? 'GET';
      if (path === '/api/handoffs' && method === 'GET') {
        return { handoffs };
      }
      if (path.startsWith('/api/handoffs/') && method === 'POST') {
        return { ok: true };
      }
      throw new Error(`Unexpected apiFetch: ${method} ${path}`);
    },
  );
}

/** Collect POST /api/handoffs/* calls. */
function postCalls() {
  return mockApiFetch.mock.calls.filter(
    ([, opts]: [string, RequestInit | undefined]) =>
      (opts?.method?.toUpperCase() ?? 'GET') === 'POST',
  );
}

// ---------------------------------------------------------------------------
// Tests — no fake timers (interval fires but mock is stable; act() is happy)
// ---------------------------------------------------------------------------

describe('HandoffsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Loading state
  // -------------------------------------------------------------------------

  it('shows "Loading handoffs…" before the fetch resolves', async () => {
    let resolve!: (v: unknown) => void;
    mockApiFetch.mockReturnValue(new Promise((r) => { resolve = r; }));
    render(<HandoffsView />);
    expect(screen.getByText('Loading handoffs…')).toBeInTheDocument();
    await act(async () => { resolve({ handoffs: [] }); });
    await waitFor(() =>
      expect(screen.queryByText('Loading handoffs…')).not.toBeInTheDocument(),
    );
  });

  // -------------------------------------------------------------------------
  // Empty state
  // -------------------------------------------------------------------------

  it('shows "No pending handoffs." when the list is empty', async () => {
    setupApiFetch([]);
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByText('No pending handoffs.')).toBeInTheDocument(),
    );
  });

  // -------------------------------------------------------------------------
  // Renders a handoff card
  // -------------------------------------------------------------------------

  it('renders a pending handoff card with its question message', async () => {
    setupApiFetch([makeHandoff({ questionMessage: 'Deploy to staging?' })]);
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByText('Deploy to staging?')).toBeInTheDocument(),
    );
    expect(screen.getByText('Pending Handoffs')).toBeInTheDocument();
  });

  it('renders the sessionId in the card', async () => {
    setupApiFetch([makeHandoff({ sessionId: 'sess-xyz' })]);
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByText('sess-xyz')).toBeInTheDocument(),
    );
  });

  it('shows the pending count badge when handoffs > 0', async () => {
    setupApiFetch([
      makeHandoff({ taskId: 'q-1' }),
      makeHandoff({ taskId: 'q-2', questionMessage: 'Another question?' }),
    ]);
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByText('2 pending')).toBeInTheDocument(),
    );
  });

  // -------------------------------------------------------------------------
  // Choice / select type — clickable buttons
  // -------------------------------------------------------------------------

  it('renders choice buttons for a select-type handoff', async () => {
    setupApiFetch([
      makeHandoff({
        questionType: 'select',
        questionChoices: ['staging', 'production'],
      }),
    ]);
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'staging' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'production' })).toBeInTheDocument();
  });

  it('POSTs the chosen option when a choice button is clicked', async () => {
    setupApiFetch([
      makeHandoff({
        taskId: 'q-choice',
        questionType: 'select',
        questionChoices: ['staging', 'production'],
      }),
    ]);
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'staging' })).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'staging' }));
    });
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    const [path, opts] = postCalls()[0] as [string, RequestInit];
    expect(path).toBe('/api/handoffs/q-choice/answer');
    expect(JSON.parse(opts.body as string)).toEqual({ answer: 'staging' });
  });

  it('removes the card after a successful choice answer', async () => {
    setupApiFetch([
      makeHandoff({
        taskId: 'q-remove',
        questionMessage: 'Remove me?',
        questionType: 'select',
        questionChoices: ['yes'],
      }),
    ]);
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByText('Remove me?')).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'yes' }));
    });
    await waitFor(() =>
      expect(screen.queryByText('Remove me?')).not.toBeInTheDocument(),
    );
  });

  // -------------------------------------------------------------------------
  // Confirm type — Yes / No buttons
  // -------------------------------------------------------------------------

  it('renders Yes/No buttons for a confirm-type handoff', async () => {
    setupApiFetch([makeHandoff({ questionType: 'confirm' })]);
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Yes' })).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'No' })).toBeInTheDocument();
  });

  it('POSTs true when Yes is clicked', async () => {
    setupApiFetch([
      makeHandoff({ taskId: 'q-confirm', questionType: 'confirm' }),
    ]);
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Yes' })).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    });
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    const [path, opts] = postCalls()[0] as [string, RequestInit];
    expect(path).toBe('/api/handoffs/q-confirm/answer');
    expect(JSON.parse(opts.body as string)).toEqual({ answer: true });
  });

  it('POSTs false when No is clicked', async () => {
    setupApiFetch([
      makeHandoff({ taskId: 'q-no', questionType: 'confirm' }),
    ]);
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'No' })).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'No' }));
    });
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    expect(
      JSON.parse((postCalls()[0] as [string, RequestInit])[1].body as string),
    ).toEqual({ answer: false });
  });

  it('renders Yes/No for a handoff with no question type', async () => {
    setupApiFetch([
      makeHandoff({ questionType: undefined, questionChoices: undefined }),
    ]);
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Yes' })).toBeInTheDocument(),
    );
  });

  // -------------------------------------------------------------------------
  // select/choice with empty or absent choices → free-text fallback
  // -------------------------------------------------------------------------

  it('falls back to free-text when type is select but choices is undefined', async () => {
    setupApiFetch([
      makeHandoff({ questionType: 'select', questionChoices: undefined }),
    ]);
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Your answer…')).toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: /staging|production/i })).not.toBeInTheDocument();
  });

  it('falls back to free-text when type is select but choices is empty', async () => {
    setupApiFetch([
      makeHandoff({ questionType: 'select', questionChoices: [] }),
    ]);
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Your answer…')).toBeInTheDocument(),
    );
  });

  it('falls back to free-text when type is choice but choices is undefined', async () => {
    setupApiFetch([
      makeHandoff({ questionType: 'choice', questionChoices: undefined }),
    ]);
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Your answer…')).toBeInTheDocument(),
    );
  });

  // -------------------------------------------------------------------------
  // Free-text type
  // -------------------------------------------------------------------------

  it('renders a text input + Submit for an unrecognised type', async () => {
    setupApiFetch([makeHandoff({ questionType: 'text' })]);
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Your answer…')).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: 'Submit' })).toBeInTheDocument();
  });

  it('POSTs the typed text when Submit is clicked', async () => {
    setupApiFetch([
      makeHandoff({ taskId: 'q-text', questionType: 'text' }),
    ]);
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Your answer…')).toBeInTheDocument(),
    );
    act(() => {
      fireEvent.change(screen.getByPlaceholderText('Your answer…'), {
        target: { value: 'my-answer' },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    });
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    const [path, opts] = postCalls()[0] as [string, RequestInit];
    expect(path).toBe('/api/handoffs/q-text/answer');
    expect(JSON.parse(opts.body as string)).toEqual({ answer: 'my-answer' });
  });

  it('POSTs trimmed text when Enter is pressed', async () => {
    setupApiFetch([
      makeHandoff({ taskId: 'q-enter', questionType: 'text' }),
    ]);
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Your answer…')).toBeInTheDocument(),
    );
    act(() => {
      fireEvent.change(screen.getByPlaceholderText('Your answer…'), {
        target: { value: '  trimmed  ' },
      });
    });
    await act(async () => {
      fireEvent.keyDown(screen.getByPlaceholderText('Your answer…'), {
        key: 'Enter',
        code: 'Enter',
      });
    });
    await waitFor(() => expect(postCalls()).toHaveLength(1));
    const [path, opts] = postCalls()[0] as [string, RequestInit];
    expect(path).toBe('/api/handoffs/q-enter/answer');
    expect(JSON.parse(opts.body as string)).toEqual({ answer: 'trimmed' });
  });

  it('does not POST when Enter is pressed with whitespace-only input', async () => {
    setupApiFetch([
      makeHandoff({ taskId: 'q-blank', questionType: 'text' }),
    ]);
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Your answer…')).toBeInTheDocument(),
    );
    act(() => {
      fireEvent.change(screen.getByPlaceholderText('Your answer…'), {
        target: { value: '   ' },
      });
    });
    await act(async () => {
      fireEvent.keyDown(screen.getByPlaceholderText('Your answer…'), {
        key: 'Enter',
        code: 'Enter',
      });
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(postCalls()).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // 409 → "no longer active" error message
  // -------------------------------------------------------------------------

  it('shows "no longer active" error when POST returns a 409-like error', async () => {
    mockApiFetch.mockImplementation(
      async (path: string, options?: RequestInit) => {
        const method = options?.method?.toUpperCase() ?? 'GET';
        if (method === 'GET') {
          return { handoffs: [makeHandoff({ questionType: 'confirm' })] };
        }
        throw new ApiError(409, '{"error":"no_longer_active"}');
      },
    );
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Yes' })).toBeInTheDocument(),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    });
    await waitFor(() =>
      expect(screen.getByText(/no longer active/i)).toBeInTheDocument(),
    );
  });

  // -------------------------------------------------------------------------
  // GET error → error banner
  // -------------------------------------------------------------------------

  it('shows an error banner when GET /api/handoffs throws', async () => {
    mockApiFetch.mockRejectedValue(new Error('Network error'));
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByText('Network error')).toBeInTheDocument(),
    );
  });
});
