/**
 * React hook for the /api/sessions/:id/stream SSE endpoint.
 *
 * Invariant: uses fetch + ReadableStream instead of native EventSource so the
 * Authorization header can be set. EventSource only supports query-string auth,
 * which lands the token in logs, referrers, and screen shares. The cost is
 * manually implementing Last-Event-ID resume and exponential backoff here.
 */

import { useEffect, useRef, useState } from 'react';
import { getToken } from '@/lib/api';

export type StreamStatus = 'connecting' | 'open' | 'reconnecting' | 'closed' | 'ended';

const MAX_BACKOFF_MS = 15_000;
const BASE_BACKOFF_MS = 500;

// Inline SSE parsing — avoids importing from the server-side sse-protocol module.

interface ParsedSseEvent {
  id: string | undefined;
  data: string;
}

interface ParseSseChunkResult {
  events: ParsedSseEvent[];
  remainder: string;
}

function parseSseChunk(buffer: string): ParseSseChunkResult {
  const normalized = buffer.replace(/\r\n/g, '\n');
  const rawFrames = normalized.split('\n\n');
  const remainder = rawFrames.pop() ?? '';

  const events: ParsedSseEvent[] = [];
  for (const rawFrame of rawFrames) {
    if (rawFrame.trim() === '') continue;
    let id: string | undefined;
    let data: string | undefined;
    for (const line of rawFrame.split('\n')) {
      if (line.startsWith('id: ')) {
        id = line.slice('id: '.length);
      } else if (line.startsWith('id:')) {
        id = line.slice('id:'.length).trimStart();
      } else if (line.startsWith('data: ')) {
        data = line.slice('data: '.length);
      } else if (line.startsWith('data:')) {
        data = line.slice('data:'.length).trimStart();
      }
      // Comment/keepalive lines starting with ':' are ignored.
    }
    if (data !== undefined) {
      events.push({ id, data });
    }
  }

  return { events, remainder };
}

function isSseEndFrame(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    (payload as { end?: unknown }).end === true
  );
}

export interface UseSseStreamResult {
  /** Raw SSE payloads in arrival order. */
  events: unknown[];
  status: StreamStatus;
  error: string | null;
}

/**
 * Connect to the SSE stream for a session.
 *
 * When sessionId changes the old connection is torn down and a new one opens.
 * Passing null disconnects without opening anything.
 */
export function useSseStream(sessionId: string | null): UseSseStreamResult {
  const [events, setEvents] = useState<unknown[]>([]);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [error, setError] = useState<string | null>(null);

  // Stable refs so the async loop always reads current values without
  // appearing as effect dependencies.
  const abortRef = useRef<AbortController | undefined>(undefined);
  const lastEventIdRef = useRef<string | undefined>(undefined);
  const attemptRef = useRef(0);
  const stoppedRef = useRef(false);

  useEffect(() => {
    if (sessionId === null) {
      // No session selected — stay silent, don't mark as closed.
      setEvents([]);
      setStatus('connecting');
      setError(null);
      return;
    }

    // Capture as a non-null string so the async closure sees the narrowed type.
    const sid: string = sessionId;

    // Reset state for the new session.
    setEvents([]);
    setError(null);
    stoppedRef.current = false;
    lastEventIdRef.current = undefined;
    attemptRef.current = 0;

    async function connect(): Promise<void> {
      if (stoppedRef.current) return;

      setStatus(attemptRef.current === 0 ? 'connecting' : 'reconnecting');

      let ended = false;
      const controller = new AbortController();
      abortRef.current = controller;

      const token = getToken();
      const headers: Record<string, string> = {};
      if (token) headers['authorization'] = `Bearer ${token}`;
      if (lastEventIdRef.current !== undefined) {
        headers['last-event-id'] = lastEventIdRef.current;
      }

      try {
        const res = await fetch(
          `/api/sessions/${encodeURIComponent(sid)}/stream`,
          { headers, signal: controller.signal },
        );

        // Permanent errors — stop and surface, do not retry.
        if (!res.ok) {
          if (res.status === 401 || res.status === 403 || res.status === 404) {
            stoppedRef.current = true;
            const reason =
              res.status === 401
                ? 'unauthorized'
                : res.status === 403
                  ? 'forbidden'
                  : 'not-found';
            setError(reason);
            setStatus('closed');
            return;
          }
          throw new Error(`stream ${res.status}`);
        }
        if (res.body === null) throw new Error('stream: no body');

        attemptRef.current = 0;
        setStatus('open');

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        outer: for (;;) {
          const { done, value } = await reader.read();
          // Guard: the effect may have been torn down while we were awaiting;
          // discard this frame rather than forwarding it to a new session.
          if (stoppedRef.current) break;
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const { events: frames, remainder } = parseSseChunk(buffer);
          buffer = remainder;

          for (const frame of frames) {
            if (frame.id !== undefined) lastEventIdRef.current = frame.id;

            let payload: unknown;
            try {
              payload = JSON.parse(frame.data) as unknown;
            } catch {
              // A single malformed frame must not tear down the stream.
              continue;
            }

            // Invariant: the terminal frame is consumed here and NOT forwarded
            // to callers, matching the behaviour in the original sse-client.ts.
            if (isSseEndFrame(payload)) {
              ended = true;
              stoppedRef.current = true;
              break outer;
            }

            setEvents((prev) => [...prev, payload]);
          }
        }
      } catch (err) {
        // Ignore AbortError (from stop/cleanup) — fall through to reconnect.
        if (err instanceof DOMException && err.name === 'AbortError') {
          return;
        }
        // Other errors fall through to reconnect.
      }

      // Contract: stoppedRef is set by explicit stop (cleanup) OR by the
      // terminal frame above. Both paths skip the reconnect.
      if (stoppedRef.current) {
        if (ended) setStatus('ended');
        return;
      }

      attemptRef.current += 1;
      // ±25% jitter prevents thundering-herd when multiple components reconnect.
      const jitter = 0.75 + Math.random() * 0.5;
      const delay =
        Math.min(BASE_BACKOFF_MS * 2 ** (attemptRef.current - 1), MAX_BACKOFF_MS) * jitter;
      setTimeout(() => void connect(), delay);
    }

    void connect();

    return () => {
      stoppedRef.current = true;
      abortRef.current?.abort();
      setStatus('closed');
    };
  }, [sessionId]);

  return { events, status, error };
}
