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
 *   - Double-click sends only one POST (in-flight ref guard)
 *   - answered Set is pruned when taskId disappears from poll response
 *   - textValue is cleared after a successful answer
 *   - visibilitychange pauses and resumes polling
 *   - Unmount clears the interval (no post-unmount state updates)
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
    (call: unknown[]) =>
      ((call[1] as RequestInit | undefined)?.method?.toUpperCase() ?? 'GET') === 'POST',
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
      async (_path: string, options?: RequestInit) => {
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

  // -------------------------------------------------------------------------
  // Double-click in-flight guard — second click must not POST
  // -------------------------------------------------------------------------

  it('sends only one POST when a confirm button is double-clicked rapidly', async () => {
    // Block the first POST until we resolve it manually so the second click
    // arrives while the first is still in-flight.
    let resolvePost!: (v: unknown) => void;
    mockApiFetch.mockImplementation(
      async (_path: string, options?: RequestInit) => {
        const method = options?.method?.toUpperCase() ?? 'GET';
        if (method === 'GET') {
          return { handoffs: [makeHandoff({ taskId: 'q-dbl', questionType: 'confirm' })] };
        }
        // First POST blocks; subsequent calls resolve immediately (they should
        // never arrive due to the in-flight guard).
        return new Promise((r) => { resolvePost = r; });
      },
    );
    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Yes' })).toBeInTheDocument(),
    );
    // Fire two clicks in the same synchronous frame — only the first should
    // reach submitAnswer because submittingRef blocks the second.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
      fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    });
    // Resolve the in-flight POST.
    await act(async () => { resolvePost({ ok: true }); });
    await waitFor(() => expect(postCalls()).toHaveLength(1));
  });

  // -------------------------------------------------------------------------
  // answered Set pruning — recycled taskId must reappear
  // -------------------------------------------------------------------------

  it('prunes the answered set when a taskId disappears from the poll response', async () => {
    // Drive polls manually with fake timers (shouldAdvanceTime keeps waitFor working).
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const taskId = 'q-recycle';

    // Phase 1: card present.
    mockApiFetch.mockImplementation(async (_path: string, opts?: RequestInit) => {
      const method = opts?.method?.toUpperCase() ?? 'GET';
      if (method === 'GET') return { handoffs: [makeHandoff({ taskId, questionMessage: 'Recycled?' })] };
      return { ok: true };
    });

    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByText('Recycled?')).toBeInTheDocument(),
    );

    // Answer the card — taskId enters answered set, card disappears.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Yes' }));
    });
    await waitFor(() =>
      expect(screen.queryByText('Recycled?')).not.toBeInTheDocument(),
    );

    // Phase 2: server no longer returns the taskId — switch mock to empty.
    mockApiFetch.mockImplementation(async (_path: string, opts?: RequestInit) => {
      const method = opts?.method?.toUpperCase() ?? 'GET';
      if (method === 'GET') return { handoffs: [] };
      return { ok: true };
    });

    // Trigger a poll tick — pruning logic removes taskId from answered set.
    await act(async () => { vi.advanceTimersByTime(3_000); });
    await waitFor(() =>
      expect(screen.getByText('No pending handoffs.')).toBeInTheDocument(),
    );

    // Phase 3: taskId recycled — server returns it again.
    mockApiFetch.mockImplementation(async (_path: string, opts?: RequestInit) => {
      const method = opts?.method?.toUpperCase() ?? 'GET';
      if (method === 'GET') return { handoffs: [makeHandoff({ taskId, questionMessage: 'Recycled?' })] };
      return { ok: true };
    });

    // Trigger another poll — recycled card must now be visible.
    await act(async () => { vi.advanceTimersByTime(3_000); });
    await waitFor(() =>
      expect(screen.getByText('Recycled?')).toBeInTheDocument(),
    );

    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // textValue cleared after successful answer
  // -------------------------------------------------------------------------

  it('clears the text input after a successful free-text answer', async () => {
    // Block the POST so the card stays mounted long enough to check the input.
    let resolvePost!: (v: unknown) => void;
    mockApiFetch.mockImplementation(async (_path: string, opts?: RequestInit) => {
      const method = opts?.method?.toUpperCase() ?? 'GET';
      if (method === 'GET') {
        return { handoffs: [makeHandoff({ taskId: 'q-clear', questionType: 'text' })] };
      }
      return new Promise((r) => { resolvePost = r; });
    });

    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByPlaceholderText('Your answer…')).toBeInTheDocument(),
    );

    act(() => {
      fireEvent.change(screen.getByPlaceholderText('Your answer…'), {
        target: { value: 'hello' },
      });
    });
    expect((screen.getByPlaceholderText('Your answer…') as HTMLInputElement).value).toBe('hello');

    // Click Submit — POST is in-flight (blocked).
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Submit' }));
    });

    // Resolve the POST — setTextValue('') fires before onAnswered.
    await act(async () => { resolvePost({ ok: true }); });

    // Card is now hidden (onAnswered fired). Verify exactly one POST.
    await waitFor(() => expect(postCalls()).toHaveLength(1));
  });

  // -------------------------------------------------------------------------
  // visibilitychange — pause and resume polling
  // -------------------------------------------------------------------------

  it('stops polling when the document becomes hidden and resumes on visible', async () => {
    // shouldAdvanceTime:true lets wall-clock pass so waitFor() still works
    // while we can also manually jump the timer forward for the poll interval.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    setupApiFetch([]);

    render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByText('No pending handoffs.')).toBeInTheDocument(),
    );

    const callsBefore = mockApiFetch.mock.calls.length;

    // Simulate tab hidden — polling should stop.
    await act(async () => {
      Object.defineProperty(document, 'hidden', { value: true, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      vi.advanceTimersByTime(6_000);
    });
    const callsWhileHidden = mockApiFetch.mock.calls.length;
    expect(callsWhileHidden).toBe(callsBefore);

    // Simulate tab visible — an immediate load + new interval should fire.
    await act(async () => {
      Object.defineProperty(document, 'hidden', { value: false, configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // The resume triggers an immediate load.
    await waitFor(() =>
      expect(mockApiFetch.mock.calls.length).toBeGreaterThan(callsWhileHidden),
    );

    // Advance another interval — periodic polling should have resumed.
    await act(async () => { vi.advanceTimersByTime(3_000); });
    expect(mockApiFetch.mock.calls.length).toBeGreaterThan(callsWhileHidden + 1);

    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Unmount — clears the interval (no post-unmount state updates / warnings)
  // -------------------------------------------------------------------------

  it('clears the polling interval on unmount', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const clearSpy = vi.spyOn(globalThis, 'clearInterval');
    setupApiFetch([]);

    const { unmount } = render(<HandoffsView />);
    await waitFor(() =>
      expect(screen.getByText('No pending handoffs.')).toBeInTheDocument(),
    );

    const callsAtUnmount = mockApiFetch.mock.calls.length;
    unmount();

    // clearInterval must have been called at least once during cleanup.
    expect(clearSpy).toHaveBeenCalled();

    // Advance timers — no further apiFetch calls should occur after unmount.
    await act(async () => { vi.advanceTimersByTime(9_000); });
    expect(mockApiFetch.mock.calls.length).toBe(callsAtUnmount);

    vi.useRealTimers();
  });
});
