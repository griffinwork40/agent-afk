/**
 * Pending daemon handoffs view.
 *
 * Polls GET /api/handoffs every 3 s to show questions that the daemon has
 * paused on. Each card lets the operator answer via
 * POST /api/handoffs/:taskId/answer.  The bearer token (attached by
 * `apiFetch`) plus the matching Origin header are the CSRF gate — no cookie
 * is used, so no additional CSRF token field is needed in the UI.
 *
 * Answer form adapts to question.type:
 *   - "select" / "choice" / (array of choices) → clickable choice buttons
 *   - "confirm" (or no type)                  → Yes / No
 *   - anything else                            → free-text input + Submit
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { apiFetch, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { HandoffSummary, HandoffsResponse } from '@/types/api';

const POLL_INTERVAL_MS = 3_000;

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------

async function fetchHandoffs(): Promise<HandoffSummary[]> {
  const data = await apiFetch<HandoffsResponse>('/api/handoffs');
  return data.handoffs;
}

async function submitAnswer(taskId: string, answer: unknown): Promise<void> {
  await apiFetch(`/api/handoffs/${encodeURIComponent(taskId)}/answer`, {
    method: 'POST',
    body: JSON.stringify({ answer }),
  });
}

// ---------------------------------------------------------------------------
// HandoffCard — one pending question
// ---------------------------------------------------------------------------

function HandoffCard({
  handoff,
  onAnswered,
}: {
  handoff: HandoffSummary;
  onAnswered: (taskId: string) => void;
}) {
  const { taskId, sessionId, createdAt, question } = handoff;
  const [textValue, setTextValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answer = useCallback(
    async (value: unknown) => {
      setBusy(true);
      setError(null);
      try {
        await submitAnswer(taskId, value);
        onAnswered(taskId);
      } catch (err) {
        if (err instanceof ApiError && err.status === 409) {
          setError('This handoff is no longer active (already answered).');
        } else {
          setError('Failed to submit — try again.');
        }
      } finally {
        setBusy(false);
      }
    },
    [taskId, onAnswered],
  );

  const hasChoices =
    Array.isArray(question.choices) && question.choices.length > 0;
  const type = question.type ?? 'confirm';
  const isSelectLike = hasChoices || type === 'select' || type === 'choice';
  const isConfirm = !isSelectLike && (type === 'confirm' || !question.type);

  const relativeTime = (() => {
    try {
      const diff = Date.now() - new Date(createdAt).getTime();
      const s = Math.floor(diff / 1000);
      if (s < 60) return `${s}s ago`;
      const m = Math.floor(s / 60);
      if (m < 60) return `${m}m ago`;
      return `${Math.floor(m / 60)}h ago`;
    } catch {
      return '';
    }
  })();

  return (
    <div
      className={cn(
        'rounded-xl border-2 border-yellow-500/60 bg-yellow-500/5 p-4',
        'flex flex-col gap-3',
      )}
    >
      {/* Header */}
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-yellow-500" />
        <div className="min-w-0 flex-1">
          <p className="text-xs text-muted-foreground">
            Session <span className="font-mono">{sessionId}</span>
            {relativeTime && <span> · {relativeTime}</span>}
          </p>
          {question.message && (
            <p className="mt-1 text-sm font-medium text-foreground">
              {question.message}
            </p>
          )}
          {!question.message && (
            <p className="mt-1 text-sm text-muted-foreground italic">
              (no message)
            </p>
          )}
        </div>
      </div>

      {/* Answer controls */}
      {isSelectLike && (
        <div className="flex flex-wrap gap-1.5">
          {(question.choices ?? []).map((choice, idx) => {
            const label = String(choice);
            return (
              <button
                key={`${label}-${idx}`}
                onClick={() => { void answer(choice); }}
                disabled={busy}
                className={cn(
                  'rounded-md border border-border px-3 py-1 text-xs font-medium',
                  'transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50',
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
      )}

      {isConfirm && (
        <div className="flex justify-end gap-2">
          <button
            onClick={() => { void answer(false); }}
            disabled={busy}
            className={cn(
              'h-7 rounded-md px-3 text-xs text-muted-foreground',
              'hover:bg-accent hover:text-foreground disabled:opacity-50',
            )}
          >
            No
          </button>
          <button
            onClick={() => { void answer(true); }}
            disabled={busy}
            className={cn(
              'h-7 rounded-md bg-brand px-3 text-xs font-medium text-white',
              'hover:bg-brand/90 disabled:opacity-50',
            )}
          >
            Yes
          </button>
        </div>
      )}

      {!isSelectLike && !isConfirm && (
        <div className="flex gap-2">
          <input
            type="text"
            value={textValue}
            onChange={(e) => setTextValue(e.target.value)}
            disabled={busy}
            placeholder="Your answer…"
            className={cn(
              'flex-1 rounded-md border border-input bg-background px-3 py-1 text-sm',
              'placeholder:text-muted-foreground/50',
              'focus:outline-none focus:ring-2 focus:ring-ring',
              'disabled:cursor-not-allowed disabled:opacity-50',
            )}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && textValue.trim()) void answer(textValue);
            }}
          />
          <button
            onClick={() => { void answer(textValue); }}
            disabled={busy || !textValue.trim()}
            className={cn(
              'h-8 rounded-md bg-brand px-3 text-xs font-medium text-white',
              'hover:bg-brand/90 disabled:opacity-50',
            )}
          >
            Submit
          </button>
        </div>
      )}

      {error && (
        <p className="rounded-md border border-status-failed/30 bg-status-failed/10 px-3 py-2 text-xs text-status-failed">
          {error}
        </p>
      )}

      <p className="font-mono text-[10px] text-muted-foreground/60">{taskId}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// HandoffsView — main export
// ---------------------------------------------------------------------------

export function HandoffsView() {
  const [handoffs, setHandoffs] = useState<HandoffSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Track locally-answered taskIds so the card disappears immediately without
  // waiting for the next poll cycle.
  const [answered, setAnswered] = useState<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const inFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const list = await fetchHandoffs();
      setHandoffs(list);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load handoffs.');
    } finally {
      inFlightRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    timerRef.current = setInterval(() => { void load(); }, POLL_INTERVAL_MS);
    return () => clearInterval(timerRef.current);
  }, [load]);

  const handleAnswered = useCallback((taskId: string) => {
    setAnswered((prev) => new Set([...prev, taskId]));
  }, []);

  const visible = handoffs.filter((h) => !answered.has(h.taskId));

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading handoffs…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-base font-semibold">Pending Handoffs</h1>
        {visible.length > 0 && (
          <span className="rounded-full bg-yellow-500/20 px-2 py-0.5 text-xs font-medium text-yellow-700 dark:text-yellow-400">
            {visible.length} pending
          </span>
        )}
      </div>

      {error && (
        <p className="rounded-lg border border-status-failed/30 bg-status-failed/10 px-4 py-3 text-sm text-status-failed">
          {error}
        </p>
      )}

      {!error && visible.length === 0 && (
        <p className="mt-8 text-center text-sm text-muted-foreground">
          No pending handoffs.
        </p>
      )}

      <div className="flex flex-col gap-3">
        {visible.map((h) => (
          <HandoffCard key={h.taskId} handoff={h} onAnswered={handleAnswered} />
        ))}
      </div>
    </div>
  );
}
