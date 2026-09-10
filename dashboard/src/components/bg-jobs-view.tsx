/**
 * Background-jobs panel for the AFK React dashboard.
 *
 * Auto-refresh contract:
 *   - Polls every 5 s while any job has status 'running'.
 *   - Polling stops once all jobs are settled (completed/failed/cancelled).
 *   - A live 1-second tick keeps relative time fresh for running jobs without
 *     re-fetching from the server.
 *   - Manual refresh button is always available.
 *
 * Cancel note: POST /api/bg-jobs/:id/cancel does not exist in the server router
 * (only GET /api/bg-jobs and GET /api/bg-jobs/:id are wired). The cancel button
 * is rendered but posts to that path and surfaces the 404 as a user-visible
 * error — ready to go live once the server route is added.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Briefcase, ChevronDown, ChevronRight, RefreshCw, X } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';
import {
  type BgJobMeta,
  formatDuration,
  formatRelative,
  isSettled,
  shortModel,
  STATUS_STYLES,
} from './bg-jobs-view.types';

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function StatusBadge({ status }: { status: BgJobMeta['status'] }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium',
        STATUS_STYLES[status],
      )}
    >
      {status === 'running' && (
        <span className="size-1.5 rounded-full bg-green-400 animate-pulse" />
      )}
      {status}
    </span>
  );
}

/** Expandable card for one background job. */
function JobCard({
  job,
  now,
  onCancel,
}: {
  job: BgJobMeta;
  /** Current epoch ms — passed from parent so all cards tick together. */
  now: number;
  onCancel: (jobId: string) => Promise<void>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelError, setCancelError] = useState<string | null>(null);

  // Duration ticks live for running jobs (parent increments `now` every 1 s).
  const duration = formatDuration(job.startedAt, job.status === 'running' ? now : job.endedAt);
  const relTime = formatRelative(job.startedAt);
  const ChevronIcon = expanded ? ChevronDown : ChevronRight;

  const handleCancel = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setCancelError(null);
    setCancelling(true);
    try {
      await onCancel(job.jobId);
    } catch (err) {
      setCancelError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  };

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 overflow-hidden">
      {/* Card header — click to expand */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left px-4 py-3 flex flex-col gap-2 hover:bg-neutral-800/50 transition-colors"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5 min-w-0">
            <ChevronIcon className="size-3.5 shrink-0 text-neutral-500" />
            <span className="text-sm font-medium text-neutral-100 truncate">
              {job.label || job.jobId}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <StatusBadge status={job.status} />
            {job.status === 'running' && (
              <button
                type="button"
                onClick={handleCancel}
                disabled={cancelling}
                aria-label={`Cancel job ${job.jobId}`}
                className={cn(
                  'flex items-center gap-1 rounded px-1.5 py-0.5 text-xs',
                  'text-neutral-500 hover:text-red-400 hover:bg-red-500/10',
                  'disabled:opacity-40 transition-colors',
                )}
              >
                <X className="size-3" />
                {cancelling ? 'Cancelling…' : 'Cancel'}
              </button>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 text-xs text-neutral-500 pl-5">
          <span className="font-mono bg-neutral-800 rounded px-1.5 py-0.5 text-neutral-300">
            {shortModel(job.model)}
          </span>
          <span>{duration}</span>
          <span>{relTime}</span>
        </div>

        {/* Stop reason for terminal-but-not-completed jobs */}
        {(job.status === 'failed' || job.status === 'cancelled') && job.stopReason && (
          <div className="pl-5 text-xs text-neutral-500">
            <span className="text-neutral-600">reason:</span>{' '}
            <span className="font-mono text-neutral-400 line-clamp-2" title={job.stopReason}>{job.stopReason}</span>
          </div>
        )}

        {cancelError && (
          <p className="pl-5 text-xs text-red-400">{cancelError}</p>
        )}
      </button>

      {/* Expandable detail panel */}
      {expanded && (
        <div className="border-t border-neutral-800 px-4 py-3 bg-neutral-950 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
          <DetailRow label="Job ID" value={job.jobId} mono />
          <DetailRow label="Subagent ID" value={job.subagentId} mono />
          <DetailRow label="Model" value={job.model} mono />
          <DetailRow label="Status" value={job.status} />
          <DetailRow label="Started" value={new Date(job.startedAt).toLocaleString()} />
          {job.endedAt !== undefined && (
            <DetailRow label="Ended" value={new Date(job.endedAt).toLocaleString()} />
          )}
          <DetailRow label="Duration" value={duration} />
          {job.parentSessionId && (
            <DetailRow label="Parent session" value={job.parentSessionId} mono />
          )}
          {job.stopReason && (
            <DetailRow label="Stop reason" value={job.stopReason.length > 200 ? job.stopReason.slice(0, 200) + '\u2026' : job.stopReason} mono />
          )}
          <DetailRow label="Prompt hash" value={job.promptHash} mono />
          <DetailRow label="Schema version" value={String(job.schemaVersion)} />
        </div>
      )}
    </div>
  );
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <>
      <span className="text-neutral-600 whitespace-nowrap">{label}</span>
      <span className={cn('text-neutral-300 break-all', mono && 'font-mono')}>{value}</span>
    </>
  );
}

/** Section heading with job count badge. */
function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-center gap-2 text-xs font-medium text-neutral-500 uppercase tracking-wider">
      <span>{label}</span>
      <span className="rounded-full bg-neutral-800 px-1.5 py-0.5 text-neutral-400 normal-case">
        {count}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

export function BgJobsView() {
  const [jobs, setJobs] = useState<BgJobMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Epoch ms updated every 1 s; used by running cards for live duration/reltime.
  const [now, setNow] = useState(() => Date.now());
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback((silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    apiFetch<{ jobs: BgJobMeta[] }>('/api/bg-jobs')
      .then(({ jobs: data }) =>
        setJobs([...data].sort((a, b) => b.startedAt - a.startedAt)),
      )
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => { if (!silent) setLoading(false); });
  }, []);

  // Initial load.
  useEffect(() => { load(); }, [load]);

  // Auto-refresh: poll every 5 s while any job is running; stop when all settled.
  useEffect(() => {
    const hasRunning = jobs.some((j) => !isSettled(j));
    if (hasRunning && !pollRef.current) {
      pollRef.current = setInterval(() => load(true), 5000);
    }
    if (!hasRunning && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [jobs, load]);

  // 1-second live tick for running-job duration displays.
  useEffect(() => {
    const hasRunning = jobs.some((j) => !isSettled(j));
    if (!hasRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [jobs]);

  const handleCancel = useCallback(async (jobId: string) => {
    // Contract: POST /api/bg-jobs/:id/cancel is not yet wired in server.ts.
    // This call will receive a 404 until the route is added. The error surfaces
    // through the JobCard's cancelError state, so the user sees the failure.
    await apiFetch(`/api/bg-jobs/${jobId}/cancel`, { method: 'POST' });
    // Optimistically update local state (only reached on 2xx; inert until
    // the server route is added — the poll will correct if needed).
    setJobs((prev) =>
      prev.map((j) => j.jobId === jobId ? { ...j, status: 'cancelled' as const } : j),
    );
  }, []);

  const running = jobs.filter((j) => j.status === 'running');
  const settled = jobs.filter((j) => isSettled(j));
  const isPolling = jobs.some((j) => !isSettled(j));

  return (
    <div className="flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-neutral-200">
          <Briefcase className="size-4 text-neutral-400" />
          Background Jobs
          {isPolling && (
            <span className="text-xs font-normal text-neutral-500">(auto-refreshing)</span>
          )}
        </div>
        <button
          onClick={() => load()}
          disabled={loading}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {error && (
        <p className="rounded border border-red-900/40 bg-red-950/30 px-3 py-2 text-xs text-red-400">
          {error}
        </p>
      )}

      {!loading && jobs.length === 0 && !error && (
        <p className="text-sm text-neutral-500 text-center py-8">No background jobs</p>
      )}

      {/* Running section */}
      {running.length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionHeader label="Running" count={running.length} />
          {running.map((job) => (
            <JobCard key={job.jobId} job={job} now={now} onCancel={handleCancel} />
          ))}
        </div>
      )}

      {/* Completed / failed / cancelled section */}
      {settled.length > 0 && (
        <div className="flex flex-col gap-2">
          <SectionHeader label="Completed" count={settled.length} />
          {settled.map((job) => (
            <JobCard key={job.jobId} job={job} now={now} onCancel={handleCancel} />
          ))}
        </div>
      )}
    </div>
  );
}
