import { useEffect, useState } from 'react';
import { RefreshCw, Briefcase } from 'lucide-react';
import { apiFetch } from '@/lib/api';
import { cn } from '@/lib/utils';

interface BgJobMeta {
  jobId: string;
  subagentId: string;
  label: string;
  model: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  parentSessionId?: string;
}

function formatDuration(startedAt: number, endedAt?: number): string {
  const ms = (endedAt ?? Date.now()) - startedAt;
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

function formatRelative(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

const STATUS_STYLES: Record<BgJobMeta['status'], string> = {
  running: 'bg-green-500/20 text-green-400 border border-green-500/30',
  completed: 'bg-blue-500/20 text-blue-400 border border-blue-500/30',
  failed: 'bg-red-500/20 text-red-400 border border-red-500/30',
  cancelled: 'bg-neutral-500/20 text-neutral-400 border border-neutral-500/30',
};

function StatusBadge({ status }: { status: BgJobMeta['status'] }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs font-medium', STATUS_STYLES[status])}>
      {status === 'running' && (
        <span className="size-1.5 rounded-full bg-green-400 animate-pulse" />
      )}
      {status}
    </span>
  );
}

function JobCard({ job }: { job: BgJobMeta }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <span className="text-sm font-medium text-neutral-100 truncate">
          {job.label || job.jobId}
        </span>
        <StatusBadge status={job.status} />
      </div>
      <div className="flex items-center gap-3 text-xs text-neutral-500">
        <span className="font-mono bg-neutral-800 rounded px-1.5 py-0.5 text-neutral-300">
          {job.model}
        </span>
        <span>{formatDuration(job.startedAt, job.endedAt)}</span>
        <span>{formatRelative(job.startedAt)}</span>
      </div>
    </div>
  );
}

export function BgJobsView() {
  const [jobs, setJobs] = useState<BgJobMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    apiFetch<{ jobs: BgJobMeta[] }>('/api/bg-jobs')
      .then(({ jobs: data }) =>
        setJobs([...data].sort((a, b) => b.startedAt - a.startedAt)),
      )
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => { load(); }, []);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-sm font-semibold text-neutral-200">
          <Briefcase className="size-4 text-neutral-400" />
          Background Jobs
        </div>
        <button
          onClick={load}
          disabled={loading}
          className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={cn('size-3', loading && 'animate-spin')} />
          Refresh
        </button>
      </div>

      {error && <p className="text-xs text-red-400">{error}</p>}

      {!loading && jobs.length === 0 && !error && (
        <p className="text-sm text-neutral-500 text-center py-8">No background jobs</p>
      )}

      <div className="flex flex-col gap-2">
        {jobs.map((job) => <JobCard key={job.jobId} job={job} />)}
      </div>
    </div>
  );
}
