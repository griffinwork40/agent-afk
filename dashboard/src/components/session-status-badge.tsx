import { cn } from '@/lib/utils';
import type { SessionSummary, SessionStatusGroup } from '@/types/api';

const statusConfig: Record<
  SessionStatusGroup,
  { label: string; className: string }
> = {
  'needs-input': {
    label: 'Needs Input',
    className:
      'bg-status-blocked/20 text-status-blocked border-status-blocked/30',
  },
  active: {
    label: 'Idle',
    className:
      'bg-status-running/20 text-status-running border-status-running/30',
  },
  completed: {
    label: 'Done',
    className: 'bg-muted text-muted-foreground border-border',
  },
};

export function classifySession(
  session: SessionSummary,
  pendingSessionIds: Set<string>,
  busySessionIds?: Set<string>,
): SessionStatusGroup {
  if (pendingSessionIds.has(session.id)) return 'needs-input';
  // A live session waiting for input is "Idle" (active), never "Done": it
  // can still take a prompt. Whether a turn is in flight is the badge's
  // separate `running` flag, which clears the moment the turn ends or is
  // stopped. A busy session is active even before its summary reports live.
  if (session.mode === 'live' || session.alive || busySessionIds?.has(session.id)) return 'active';
  return 'completed';
}

export function SessionStatusBadge({
  status,
  className,
  running = false,
}: {
  status: SessionStatusGroup;
  running?: boolean;
  className?: string;
}) {
  const config = statusConfig[status];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        config.className,
        className,
      )}
    >
      {status === 'active' && running && (
        <span className="size-1.5 animate-pulse rounded-full bg-current" />
      )}
      {status === 'active' && running ? 'Running' : config.label}
    </span>
  );
}
