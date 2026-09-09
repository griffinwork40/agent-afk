import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '@/lib/api';
import type { SessionSummary, SessionsResponse } from '@/types/api';

const POLL_INTERVAL_MS = 10_000;

interface UseSessionsResult {
  sessions: SessionSummary[];
  loading: boolean;
  error: string | null;
  refresh: () => void;
}

/**
 * Poll GET /api/sessions on an interval.
 *
 * Sessions are sorted: running/active first (by liveness), then by updatedAt
 * descending. The hook re-fetches every 10s and on manual refresh().
 */
export function useSessions(): UseSessionsResult {
  const [sessions, setSessions] = useState<SessionSummary[]>([] as SessionSummary[]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  const fetchSessions = useCallback(async () => {
    try {
      const data = await apiFetch<SessionsResponse>('/api/sessions');
      setSessions(sortSessions(data.sessions));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch sessions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSessions();
    timerRef.current = setInterval(() => void fetchSessions(), POLL_INTERVAL_MS);
    return () => clearInterval(timerRef.current);
  }, [fetchSessions]);

  return { sessions, loading, error, refresh: fetchSessions };
}

function sortSessions(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((a, b) => {
    // Active sessions first
    const aActive = isActive(a) ? 1 : 0;
    const bActive = isActive(b) ? 1 : 0;
    if (aActive !== bActive) return bActive - aActive;
    // Then by updatedAt descending
    const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return bTime - aTime;
  });
}

function isActive(s: SessionSummary): boolean {
  return s.mode === 'live' || s.alive === true;
}
