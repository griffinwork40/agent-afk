/**
 * useCommandControl — handles the A6 CommandControl result from a
 * POST /api/sessions/:id/commands response.
 *
 * Extracted from composer.tsx to keep that component under the 350-line
 * ceiling and to give the control dispatch a named, testable home.
 *
 * Supported kinds (Stage 4):
 *   continue  — no-op
 *   clear     — handled upstream in app.tsx via onCommandOutput
 *   exit      — marks session ended; calls onSessionEnded so app can show notice
 *   navigate  — selects a different session; calls onNavigate(sessionId)
 *   prefill   — sets composer text; returns false (caller must not clear)
 *   submit    — POSTs text as a new prompt
 *   rerun     — re-POSTs the rerun input to /commands (recursive, depth=1)
 *   forward   — re-POSTs the original input to /prompt
 */

import { useCallback } from 'react';
import { apiFetch } from '@/lib/api';
import type { CommandControl } from '@/types/command-wire';

export interface UseCommandControlOptions {
  sessionId: string;
  /** Called to set composer text (prefill). */
  setText: (text: string) => void;
  /** Called when a navigate control arrives. */
  onNavigate?: (targetSessionId: string) => void;
  /** Called when an exit control arrives. */
  onSessionEnded?: () => void;
  /** Called for toasts / inline notices. */
  onToast?: (message: string) => void;
}

export interface UseCommandControlResult {
  /**
   * Dispatch a CommandControl received from the server.
   * Returns true when the caller should clear the composer text,
   * false when the control manages the text itself (prefill).
   * @param depth Recursion depth for rerun controls; capped at 3.
   */
  handleControl: (control: CommandControl, originalInput: string, depth?: number) => Promise<boolean>;
}

export function useCommandControl({
  sessionId,
  setText,
  onNavigate,
  onSessionEnded,
  onToast,
}: UseCommandControlOptions): UseCommandControlResult {
  const handleControl = useCallback(
    async (control: CommandControl, originalInput: string, depth = 0): Promise<boolean> => {
      switch (control.kind) {
        case 'continue':
          return true;

        case 'clear':
          // Handled upstream via onCommandOutput in app.tsx.
          return true;

        case 'exit':
          // Session ended — show inline notice; do NOT close the tab.
          onSessionEnded?.();
          onToast?.('Session ended. Select or create a session from the sidebar.');
          return true;

        case 'navigate':
          // Navigate to the target session (fork or resume result).
          onNavigate?.(control.sessionId);
          return true;

        case 'prefill':
          setText(control.message);
          return false; // caller must NOT clear — we set the text

        case 'submit': {
          await apiFetch(`/api/sessions/${sessionId}/prompt`, {
            method: 'POST',
            body: JSON.stringify({ text: control.message }),
          });
          return true;
        }

        case 'rerun': {
          // Re-POST to /commands with the rerun string — depth-guarded to prevent
          // infinite recursion if a command keeps returning rerun controls.
          if (depth >= 3) {
            onToast?.('Command rerun limit reached');
            return true;
          }
          await apiFetch(`/api/sessions/${sessionId}/commands`, {
            method: 'POST',
            body: JSON.stringify({ input: control.input }),
          });
          return true;
        }

        case 'forward': {
          await apiFetch(`/api/sessions/${sessionId}/prompt`, {
            method: 'POST',
            body: JSON.stringify({ text: originalInput }),
          });
          return true;
        }

        default:
          return true;
      }
    },
    [sessionId, setText, onNavigate, onSessionEnded, onToast],
  );

  return { handleControl };
}
