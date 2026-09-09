import { useCallback, useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { DaemonStatus, ScheduleConfig } from '@/types/api';
import { ScheduleHistoryModal } from './schedule-history-modal';

interface SchedulesResponse {
  schedules: ScheduleConfig[];
}

interface ToggleResponse {
  ok: boolean;
  enabled: boolean;
  daemonSynced: boolean;
}

// ---------------------------------------------------------------------------
// Daemon status indicator
// ---------------------------------------------------------------------------

function DaemonIndicator({ status }: { status: DaemonStatus | null }) {
  if (!status) return null;
  return (
    <div className="flex items-center gap-2">
      <span
        className={cn(
          'size-2 rounded-full',
          status.running ? 'animate-pulse bg-status-done' : 'bg-status-failed',
        )}
      />
      <span className="text-sm text-muted-foreground">
        {status.running
          ? `Running${status.tasks != null ? ` (${status.tasks} task${status.tasks !== 1 ? 's' : ''})` : ''}`
          : 'Stopped'}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toggle switch
// ---------------------------------------------------------------------------

function ToggleSwitch({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean;
  onChange: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={(e) => {
        e.stopPropagation();
        onChange();
      }}
      disabled={disabled}
      className={cn(
        'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent',
        'transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-brand' : 'bg-muted',
      )}
    >
      <span
        className={cn(
          'block size-4 rounded-full bg-white shadow transition-transform',
          checked ? 'translate-x-4' : 'translate-x-0',
        )}
      />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Schedule card
// ---------------------------------------------------------------------------

function ScheduleCard({
  schedule,
  onToggle,
  onDelete,
  onShowHistory,
}: {
  schedule: ScheduleConfig;
  onToggle: (id: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onShowHistory: (schedule: ScheduleConfig) => void;
}) {
  const [toggling, setToggling] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleToggle = async () => {
    setToggling(true);
    await onToggle(schedule.id).finally(() => setToggling(false));
  };

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm(`Delete schedule "${schedule.name}"? This cannot be undone.`)) return;
    setDeleting(true);
    await onDelete(schedule.id).finally(() => setDeleting(false));
  };

  const triggerLabel =
    schedule.trigger === 'both'
      ? 'cron + session start'
      : schedule.trigger ?? 'cron';

  return (
    <div
      className={cn(
        'group flex cursor-pointer flex-col gap-3 rounded-xl border border-border bg-card p-4',
        'transition-colors hover:border-brand/40 hover:bg-accent/30',
        !schedule.enabled && 'opacity-60',
      )}
      onClick={() => onShowHistory(schedule)}
    >
      {/* Top row: name + controls */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-semibold">{schedule.name}</p>
          <p className="mt-0.5 font-mono text-xs text-muted-foreground">{schedule.cron}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <ToggleSwitch
            checked={schedule.enabled}
            onChange={() => { void handleToggle(); }}
            disabled={toggling}
          />
          <button
            onClick={handleDelete}
            disabled={deleting}
            aria-label={`Delete schedule ${schedule.name}`}
            className={cn(
              'flex size-7 items-center justify-center rounded-md text-muted-foreground',
              'opacity-0 transition-opacity group-hover:opacity-100',
              'hover:bg-destructive/20 hover:text-status-failed',
              'disabled:cursor-not-allowed disabled:opacity-40',
            )}
          >
            🗑
          </button>
        </div>
      </div>

      {/* Command */}
      <code className="block truncate rounded-md bg-secondary px-3 py-2 font-mono text-xs text-secondary-foreground">
        {schedule.command}
      </code>

      {/* Footer meta */}
      <div className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="rounded bg-muted px-1.5 py-0.5 capitalize">{triggerLabel}</span>
        {schedule.notifyOn && schedule.notifyOn !== 'never' && (
          <span className="rounded bg-muted px-1.5 py-0.5">
            notify: {schedule.notifyOn}
          </span>
        )}
        <span className="ml-auto">Click for history</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

export function SchedulesView() {
  const [schedules, setSchedules] = useState<ScheduleConfig[]>([]);
  const [daemon, setDaemon] = useState<DaemonStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<ScheduleConfig | null>(null);

  // Fetch schedules + daemon status in parallel on mount
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    Promise.all([
      apiFetch<SchedulesResponse>('/api/schedules'),
      apiFetch<DaemonStatus>('/api/daemon/status'),
    ])
      .then(([schRes, daemonRes]) => {
        if (cancelled) return;
        setSchedules(schRes.schedules);
        setDaemon(daemonRes);
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setError(err instanceof Error ? err.message : 'Failed to load schedules');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggle = useCallback(async (id: string) => {
    const res = await apiFetch<ToggleResponse>(`/api/schedules/${id}/toggle`, {
      method: 'POST',
    });
    setSchedules((prev) =>
      prev.map((s) => (s.id === id ? { ...s, enabled: res.enabled } : s)),
    );
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    await apiFetch<{ ok: boolean }>(`/api/schedules/${id}`, { method: 'DELETE' });
    setSchedules((prev) => prev.filter((s) => s.id !== id));
  }, []);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-sm text-muted-foreground">Loading schedules…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-base font-semibold">Schedules</h1>
        <DaemonIndicator status={daemon} />
      </div>

      {error && (
        <p className="rounded-lg border border-status-failed/30 bg-status-failed/10 px-4 py-3 text-sm text-status-failed">
          {error}
        </p>
      )}

      {!error && schedules.length === 0 && (
        <p className="mt-8 text-center text-sm text-muted-foreground">
          No schedules configured.
        </p>
      )}

      <div className="grid gap-3">
        {schedules.map((s) => (
          <ScheduleCard
            key={s.id}
            schedule={s}
            onToggle={handleToggle}
            onDelete={handleDelete}
            onShowHistory={setSelected}
          />
        ))}
      </div>

      {selected && (
        <ScheduleHistoryModal
          schedule={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}
