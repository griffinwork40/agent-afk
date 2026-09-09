import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { ScheduleConfig } from '@/types/api';

interface HistoryRecord {
  taskId: string;
  triggeredAt: string;
  durationMs: number;
  status: 'success' | 'error' | 'skipped';
  errorMessage?: string;
}

interface HistoryResponse {
  history: HistoryRecord[];
}

const STATUS_BADGE: Record<
  HistoryRecord['status'],
  { label: string; className: string }
> = {
  success: {
    label: 'Success',
    className: 'bg-status-done/20 text-status-done border-status-done/30',
  },
  error: {
    label: 'Error',
    className: 'bg-status-failed/20 text-status-failed border-status-failed/30',
  },
  skipped: {
    label: 'Skipped',
    className: 'bg-muted text-muted-foreground border-border',
  },
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ScheduleHistoryModal({
  schedule,
  onClose,
}: {
  schedule: ScheduleConfig;
  onClose: () => void;
}) {
  const [records, setRecords] = useState<HistoryRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiFetch<HistoryResponse>(`/api/schedules/${schedule.id}/history`)
      .then((res) => {
        if (!cancelled) setRecords(res.history);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to load history');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [schedule.id]);

  // Close on backdrop click or Escape key
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl border border-border bg-card shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4">
          <div>
            <h2 className="text-sm font-semibold">{schedule.name}</h2>
            <p className="mt-0.5 font-mono text-xs text-muted-foreground">
              {schedule.cron}
            </p>
          </div>
          <button
            onClick={onClose}
            className="flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 py-3">
          {loading && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              Loading history…
            </p>
          )}
          {error && (
            <p className="py-8 text-center text-sm text-status-failed">{error}</p>
          )}
          {!loading && !error && records.length === 0 && (
            <p className="py-8 text-center text-sm text-muted-foreground">
              No runs recorded yet.
            </p>
          )}
          {!loading && !error && records.length > 0 && (
            <ul className="space-y-2">
              {records.map((r, i) => {
                const badge = STATUS_BADGE[r.status];
                return (
                  <li
                    key={`${r.taskId}-${r.triggeredAt}-${i}`}
                    className="flex items-start gap-3 rounded-lg border border-border bg-background/50 px-4 py-3"
                  >
                    <span
                      className={cn(
                        'mt-0.5 shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium',
                        badge.className,
                      )}
                    >
                      {badge.label}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs text-muted-foreground">
                          {formatDate(r.triggeredAt)}
                        </span>
                        <span className="font-mono text-xs text-muted-foreground">
                          {formatDuration(r.durationMs)}
                        </span>
                      </div>
                      {r.errorMessage && (
                        <p className="mt-1 truncate font-mono text-xs text-status-failed">
                          {r.errorMessage}
                        </p>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
