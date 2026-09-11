/**
 * Tests for CreateScheduleForm in schedules-view.tsx.
 *
 * Covers:
 *   - Required-field validation fires before fetch (name, command, cron)
 *   - Successful POST calls onCreated (form hides) and propagates syncNote
 *   - API error sets formError
 *   - Cancel button fires onCancel without submitting
 */

import { render, screen, fireEvent, waitFor, act, within } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock apiFetch BEFORE importing the component so the module sees the stub.
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

import { apiFetch } from '@/lib/api';
import type { ScheduleConfig } from '@/types/api';
// Dynamic import so the mock is already installed when the module is evaluated.
const { SchedulesView } = await import('./schedules-view');

const mockApiFetch = apiFetch as ReturnType<typeof vi.fn>;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MOCK_SCHEDULE: ScheduleConfig = {
  id: 'test-schedule',
  name: 'Test Schedule',
  command: '/test --auto',
  cron: '0 2 * * *',
  trigger: 'cron',
  enabled: true,
  notifyOn: 'failure',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Configures apiFetch to handle:
 *   - GET /api/schedules  → { schedules: [] }
 *   - GET /api/daemon/status → { running: false }
 *   - POST /api/schedules  → result of `formHandler()` (optional)
 */
function setupApiFetch(
  formHandler?: () => unknown | Promise<unknown>,
) {
  mockApiFetch.mockImplementation(async (path: string, options?: RequestInit) => {
    const method = options?.method?.toUpperCase() ?? 'GET';
    if (path === '/api/schedules' && method === 'GET') return { schedules: [] };
    if (path === '/api/daemon/status') return { running: false };
    if (path === '/api/schedules' && method === 'POST') {
      if (formHandler) return formHandler();
      throw new Error(`Unexpected POST /api/schedules`);
    }
    throw new Error(`Unexpected apiFetch: ${method} ${path}`);
  });
}

/** Render SchedulesView, wait for the initial load, then open the create form. */
async function renderWithFormOpen() {
  const { container } = render(<SchedulesView />);

  // Wait for the header to appear (loading state resolved)
  await waitFor(() => expect(screen.getByText('Schedules')).toBeInTheDocument());

  // Open the form via the "+ New Schedule" button in the header
  const newBtn = screen.getByRole('button', { name: /\+ New Schedule/i });
  act(() => { fireEvent.click(newBtn); });

  // Wait for the form element to appear
  await waitFor(() => screen.getByText('New Schedule'));

  return container;
}

/** Fill name, command, and cron inside the <form> element. */
function fillForm(name: string, command: string, cron: string) {
  const form = document.querySelector('form') as HTMLFormElement;
  if (name) fireEvent.change(within(form).getByPlaceholderText(/nightly cleanup/i), { target: { value: name } });
  if (command) fireEvent.change(within(form).getByPlaceholderText(/my-skill --auto/i), { target: { value: command } });
  if (cron) fireEvent.change(within(form).getByPlaceholderText(/0 2 \* \* \*/i), { target: { value: cron } });
}

/** Submit the form by firing a submit event directly on the <form> element. */
function submitForm() {
  const form = document.querySelector('form') as HTMLFormElement;
  act(() => { fireEvent.submit(form); });
}

/** Click the Cancel button inside the form (not the header toggle). */
function clickFormCancel() {
  const form = document.querySelector('form') as HTMLFormElement;
  const cancelBtn = within(form).getByRole('button', { name: /^Cancel$/i });
  act(() => { fireEvent.click(cancelBtn); });
}

/** Count POST /api/schedules calls in mock history. */
function postCalls() {
  return mockApiFetch.mock.calls.filter(
    ([, opts]: [string, RequestInit | undefined]) =>
      opts?.method?.toUpperCase() === 'POST',
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CreateScheduleForm', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Required-field validation — no POST must fire
  // -------------------------------------------------------------------------

  describe('required-field validation', () => {
    it('shows "Name is required." and makes no POST when name is empty', async () => {
      setupApiFetch();
      await renderWithFormOpen();

      // Submit with all fields empty
      submitForm();

      await waitFor(() =>
        expect(screen.getByText('Name is required.')).toBeInTheDocument(),
      );
      expect(postCalls()).toHaveLength(0);
    });

    it('shows "Command is required." and makes no POST when command is empty', async () => {
      setupApiFetch();
      await renderWithFormOpen();

      fillForm('My Task', '', '');
      submitForm();

      await waitFor(() =>
        expect(screen.getByText('Command is required.')).toBeInTheDocument(),
      );
      expect(postCalls()).toHaveLength(0);
    });

    it('shows "Cron expression is required." and makes no POST when cron is empty', async () => {
      setupApiFetch();
      await renderWithFormOpen();

      fillForm('My Task', '/my-skill', '');
      submitForm();

      await waitFor(() =>
        expect(screen.getByText('Cron expression is required.')).toBeInTheDocument(),
      );
      expect(postCalls()).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // Successful POST → onCreated called (form hides) + syncNote propagated
  // -------------------------------------------------------------------------

  describe('successful POST', () => {
    it('closes the form and shows syncNote when the server returns one', async () => {
      const syncNote = 'Daemon is not running — task saved but not live-synced.';
      setupApiFetch(() => ({
        schedule: MOCK_SCHEDULE,
        daemonSynced: false,
        syncNote,
      }));

      await renderWithFormOpen();
      fillForm('Test Schedule', '/test --auto', '0 2 * * *');
      submitForm();

      // Form should close after successful creation
      await waitFor(() =>
        expect(screen.queryByText('New Schedule')).not.toBeInTheDocument(),
      );

      // The syncNote warning banner must appear in the page
      await waitFor(() =>
        expect(screen.getByText(syncNote)).toBeInTheDocument(),
      );
    });

    it('closes the form with no syncNote banner when daemonSynced is true', async () => {
      const syncNote = 'Daemon is not running — task saved but not live-synced.';
      setupApiFetch(() => ({
        schedule: MOCK_SCHEDULE,
        daemonSynced: true,
        // No syncNote property in response
      }));

      await renderWithFormOpen();
      fillForm('Test Schedule', '/test --auto', '0 2 * * *');
      submitForm();

      // Form should close
      await waitFor(() =>
        expect(screen.queryByText('New Schedule')).not.toBeInTheDocument(),
      );

      // syncNote banner must NOT appear
      expect(screen.queryByText(syncNote)).not.toBeInTheDocument();
    });
  });

  // -------------------------------------------------------------------------
  // API error → formError displayed, form stays open
  // -------------------------------------------------------------------------

  describe('API error handling', () => {
    it('sets formError with the error message on a thrown Error', async () => {
      setupApiFetch(() => {
        throw new Error('Internal Server Error');
      });

      await renderWithFormOpen();
      fillForm('Test Schedule', '/test --auto', '0 2 * * *');
      submitForm();

      await waitFor(() =>
        expect(screen.getByText('Internal Server Error')).toBeInTheDocument(),
      );

      // Form must remain open
      expect(screen.getByText('New Schedule')).toBeInTheDocument();
    });

    it('shows fallback error text when a non-Error value is thrown', async () => {
      setupApiFetch(() => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'something unexpected';
      });

      await renderWithFormOpen();
      fillForm('Test Schedule', '/test --auto', '0 2 * * *');
      submitForm();

      await waitFor(() =>
        expect(screen.getByText('Failed to create schedule.')).toBeInTheDocument(),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Cancel button → onCancel fires, form closes, no POST
  // -------------------------------------------------------------------------

  describe('cancel button', () => {
    it('hides the form without making a POST request', async () => {
      setupApiFetch();
      await renderWithFormOpen();

      // Form is open
      expect(screen.getByText('New Schedule')).toBeInTheDocument();

      clickFormCancel();

      // Form must close
      await waitFor(() =>
        expect(screen.queryByText('New Schedule')).not.toBeInTheDocument(),
      );

      // No POST at all
      expect(postCalls()).toHaveLength(0);
    });
  });
});
