import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { TranscriptSessionContext } from '@/hooks/use-full-tool-result';
import { apiFetch } from './api';
import type { SessionsResponse } from '@/types/api';

export const ToolSummaryCwd = createContext<string | undefined>(undefined);

/** Resolve once per transcript, never once per tool row. */
export function ToolSummaryContext({ children }: { children: ReactNode }) {
  const sessionId = useContext(TranscriptSessionContext);
  const [resolved, setResolved] = useState<{ id: string; cwd?: string }>();
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    void apiFetch<SessionsResponse>('/api/sessions', { signal: controller.signal }).then(data => {
      if (!controller.signal.aborted) setResolved({ id: sessionId, cwd: data.sessions.find(s => s.id === sessionId)?.cwd });
    }).catch(() => { /* Full paths remain useful if metadata is unavailable. */ });
    return () => controller.abort();
  }, [sessionId]);
  return <ToolSummaryCwd.Provider value={resolved?.id === sessionId ? resolved?.cwd : undefined}>{children}</ToolSummaryCwd.Provider>;
}
