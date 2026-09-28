import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FullToolOutput } from './full-tool-output';
import { TranscriptSessionContext } from '@/hooks/use-full-tool-result';
import { ApiError } from '@/lib/api';

const mockApiFetch = vi.fn();

vi.mock('@/lib/api', async (orig) => {
  const actual = await orig<typeof import('@/lib/api')>();
  return { ...actual, apiFetch: (...args: unknown[]) => mockApiFetch(...args) };
});

function renderIn(sessionId: string | null, props: Parameters<typeof FullToolOutput>[0]) {
  return render(
    <TranscriptSessionContext.Provider value={sessionId}>
      <FullToolOutput {...props} />
    </TranscriptSessionContext.Provider>,
  );
}

beforeEach(() => {
  mockApiFetch.mockReset();
});

describe('FullToolOutput', () => {
  it('shows a complete preview with no load control and fetches nothing', () => {
    renderIn('sess-1', { toolUseId: 'tu1', preview: 'all of it', clipped: false });
    expect(screen.getByText('all of it')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /load full output/i })).toBeNull();
    expect(mockApiFetch).not.toHaveBeenCalled();
  });

  it('lazy-loads the full result for a clipped preview on click', async () => {
    mockApiFetch.mockResolvedValue({ toolUseId: 'tu1', isError: false, text: 'FULL TEXT', totalChars: 9, truncated: false });
    renderIn('sess-1', { toolUseId: 'tu1', preview: 'FULL… [truncated]', clipped: true });
    expect(mockApiFetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /load full output/i }));
    await waitFor(() => expect(screen.getByText('FULL TEXT')).toBeInTheDocument());
    // The hook now passes an AbortController signal so stale requests can be
    // cancelled when the session or tool row changes before the fetch completes.
    expect(mockApiFetch).toHaveBeenCalledWith(
      '/api/sessions/sess-1/tool-results/tu1',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.queryByText('FULL… [truncated]')).toBeNull();
  });

  it('offers loading for a replayed row with no output and reports a missing journal', async () => {
    mockApiFetch.mockRejectedValue(new ApiError(404, '{"error":"journal_not_found"}'));
    renderIn('sess-1', { toolUseId: 'tu1', unavailable: true });
    expect(screen.getByText(/not in the live record/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /load full output/i }));
    await waitFor(() => expect(screen.getByText(/no message journal/i)).toBeInTheDocument());
  });

  it('notes server-side truncation of very large results', async () => {
    mockApiFetch.mockResolvedValue({ toolUseId: 'tu1', isError: false, text: 'abc', totalChars: 2_000_000, truncated: true });
    renderIn('sess-1', { toolUseId: 'tu1', preview: 'a… [truncated]', clipped: true });
    fireEvent.click(screen.getByRole('button', { name: /load full output/i }));
    await waitFor(() => expect(screen.getByText(/Showing the first/)).toBeInTheDocument());
  });

  it('offers no load control outside a session or without a toolUseId', () => {
    const { unmount } = renderIn(null, { toolUseId: 'tu1', preview: 'x', clipped: true });
    expect(screen.queryByRole('button', { name: /load full output/i })).toBeNull();
    unmount();
    renderIn('sess-1', { preview: 'x', clipped: true });
    expect(screen.queryByRole('button', { name: /load full output/i })).toBeNull();
  });
});
