/**
 * Retry / edit-and-resend via the POST /api/sessions/:id/rewind endpoint.
 *
 * Contract: both actions are no-ops while isBusy is true — the hook returns
 * early and never fires the request. The server enforces this too (409), but
 * an optimistic guard in the client avoids the round-trip.
 *
 * Usage:
 *   const { retry, editAndResend } = useRewind(sessionId, isBusy);
 *   <button onClick={retry}>Retry</button>
 *   <button onClick={() => editAndResend('new text')}>Send</button>
 */

import { useCallback } from 'react';
import { apiFetch } from '@/lib/api';

export interface UseRewindResult {
  /**
   * Rewind to just before the last user turn and resend it. `text` is that
   * prompt as displayed (what the user typed); the server falls back to the
   * rewound history text when omitted.
   */
  retry: (text?: string) => Promise<void>;
  /**
   * Rewind to just before the last user turn and send a different text.
   * This implements "edit and resend" for the most recent user message.
   */
  editAndResend: (text: string) => Promise<void>;
}

export function useRewind(sessionId: string, isBusy: boolean): UseRewindResult {
  const retry = useCallback(async (text?: string) => {
    if (isBusy) return;
    await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/rewind`, {
      method: 'POST',
      body: JSON.stringify(text?.trim() ? { mode: 'retry', text } : { mode: 'retry' }),
    });
  }, [sessionId, isBusy]);

  const editAndResend = useCallback(async (text: string) => {
    if (isBusy || !text.trim()) return;
    await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}/rewind`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'edit', text }),
    });
  }, [sessionId, isBusy]);

  return { retry, editAndResend };
}
