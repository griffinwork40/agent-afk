import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { PendingApproval } from '@/types/api';

const POLL_INTERVAL_MS = 1_000;

interface PendingResponse {
  pending: PendingApproval[];
}

/**
 * Poll GET /api/pending every second for elicitation cards.
 *
 * Returns the set of pending session IDs for status classification, plus
 * the full approval objects for rendering approval cards later (Phase 4).
 */
export function usePendingApprovals(): {
  approvals: PendingApproval[];
  pendingSessionIds: Set<string>;
} {
  const [approvals, setApprovals] = useState<PendingApproval[]>([] as PendingApproval[]);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const fetch_ = useCallback(async () => {
    try {
      const data = await apiFetch<PendingResponse>('/api/pending');
      setApprovals(data.pending);
    } catch {
      // Silently swallow - approval polling is best-effort
    }
  }, []);

  useEffect(() => {
    void fetch_();
    timerRef.current = setInterval(() => void fetch_(), POLL_INTERVAL_MS);
    return () => clearInterval(timerRef.current);
  }, [fetch_]);

  const pendingSessionIds = new Set(
    approvals.map((a) => a.sessionId).filter((id): id is string => !!id),
  );

  return { approvals, pendingSessionIds };
}
