/**
 * Approval polling and answering for `afk web`.
 *
 * Contract: `pending` state is encapsulated here and never shared directly with
 * app.ts. The two exported functions are bound by the factory so they share the
 * same `pending` array — callers do not manage it.
 *
 * Invariant: polling runs process-wide rather than per-session, because a
 * blocked turn is blocked whichever session the operator happens to be looking
 * at. Scoping this to the active session would let a background session hang
 * silently on an approval nobody was shown.
 *
 * Invariant: answerApproval addresses by REQUEST ID alone, never by session.
 * An elicitation record does not always carry a sessionId, and the old path
 * fell back to whichever session was SELECTED — so answering a prompt while
 * viewing a read-only (foreign-process) session POSTed to that session and
 * got a permanent 409, the 1s poll re-added the card, and the blocked agent
 * turn never unblocked. The request id is what the bridge resolves on anyway,
 * so the session segment constrained nothing it was ever protecting.
 *
 * Optimistic removal in answerApproval is deliberate: the card's only job is
 * to unblock the turn, and the poll re-adds it within a second if the POST
 * failed — so the row is restored by an observed server state rather than
 * assumed away.
 */

import type { PendingApproval, ApprovalAnswer } from './render.js';
import { renderApprovals } from './render.js';
import { showToast } from './app-chrome.js';

export type ApiFunction = <T>(path: string, init?: RequestInit) => Promise<T>;

export interface ApprovalsManager {
  pollPending: () => Promise<void>;
  answerApproval: (id: string, answer: ApprovalAnswer) => void;
}

/**
 * Create an encapsulated approvals manager.
 *
 * Contract: the returned functions share a single `pending` array through
 * closure — callers do not pass pending state between calls.
 */
export function createApprovalsManager(
  api: ApiFunction,
  container: HTMLElement,
): ApprovalsManager {
  let pending: PendingApproval[] = [];

  function answerApproval(id: string, answer: ApprovalAnswer): void {
    pending = pending.filter((p) => p.id !== id);
    renderApprovals(container, pending, answerApproval);
    void api('/api/approve', {
      method: 'POST',
      body: JSON.stringify({ requestId: id, response: answer }),
    }).catch((err: unknown) => {
      showToast(err instanceof Error ? err.message : 'approval failed');
    });
  }

  async function pollPending(): Promise<void> {
    const next = await api<{ pending: PendingApproval[] }>('/api/pending');
    const changed =
      next.pending.length !== pending.length ||
      next.pending.some((p, i) => p.id !== pending[i]?.id);
    pending = next.pending;
    if (changed) renderApprovals(container, pending, answerApproval);
    document.title = pending.length > 0 ? `(${pending.length}) afk web` : 'afk web';
  }

  return { pollPending, answerApproval };
}
