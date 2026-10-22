import { cn } from '@/lib/utils';
import type { SessionSummary, SessionStatusGroup } from '@/types/api';
import {
  SessionStatusBadge,
  classifySession,
} from './session-status-badge';
import { RotateCcw } from 'lucide-react';

/** Format a date as relative time ("2m ago", "3h ago", "Jan 5"). */
function relativeTime(iso: string): string {
  const now = Date.now();
  const then = new Date(iso).getTime();
  const diffSec = Math.floor((now - then) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

/** Extract the last path segment from a cwd for display. */
function cwdLabel(cwd: string): string {
  const segments = cwd.replace(/\/+$/, '').split('/');
  return segments[segments.length - 1] ?? cwd;
}

export function SessionCard({
  session,
  pendingSessionIds,
  selected,
  onSelect,
  onResume,
}: {
  session: SessionSummary;
  pendingSessionIds: Set<string>;
  selected: boolean;
  onSelect: (id: string) => void;
  /** Called when the Resume button is clicked on a readonly session. */
  onResume?: (sessionId: string) => void;
}) {
  const status: SessionStatusGroup = classifySession(session, pendingSessionIds);
  // A live session with no title has not run its first turn yet (its title
  // comes from the first user message in the ledger), so it is "new", not
  // anonymous.
  const title = session.title ?? (session.mode === 'live' ? 'New session' : 'Untitled session');

  return (
    <div
      className={cn(
        'group flex w-full flex-col gap-1.5 rounded-lg border p-3 text-left transition-colors',
        'hover:bg-accent/50',
        selected
          ? 'border-brand/50 bg-brand/5'
          : 'border-transparent',
      )}
    >
      <button
        onClick={() => onSelect(session.id)}
        className="flex w-full flex-col gap-1.5 text-left"
      >
        {/* Title row */}
        <div className="flex items-start justify-between gap-2">
          <span className="line-clamp-2 text-sm font-medium leading-snug">
            {title}
          </span>
          <SessionStatusBadge status={status} className="shrink-0" />
        </div>

        {/* Meta row */}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {session.model && (
            <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px]">
              {session.model}
            </span>
          )}
          {session.cwd && (
            <span className="truncate font-mono text-[10px]" title={session.cwd}>
              {cwdLabel(session.cwd)}
            </span>
          )}
          <span className="ml-auto shrink-0">
            {session.updatedAt ? relativeTime(session.updatedAt) : ''}
          </span>
        </div>
      </button>

      {/* Resume action for past (readonly) sessions */}
      {session.mode === 'readonly' && session.alive !== true && onResume && (
        <button
          onClick={(e) => { e.stopPropagation(); onResume(session.id); }}
          className={cn(
            'flex items-center gap-1.5 self-start rounded px-2 py-0.5',
            'text-xs text-muted-foreground transition-colors',
            'hover:bg-accent hover:text-foreground',
            'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          )}
          title="Resume this session"
          aria-label="Resume this session"
        >
          <RotateCcw className="size-3" />
          Resume
        </button>
      )}
    </div>
  );
}
