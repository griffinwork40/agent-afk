import type { SessionSummary } from '@/types/api';

/**
 * Placeholder for Phase 2 (transcript + SSE streaming).
 *
 * Shows session metadata until the full transcript viewer is built.
 */
export function SessionDetailPlaceholder({
  session,
}: {
  session: SessionSummary;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 text-muted-foreground">
      <div className="flex flex-col items-center gap-2 rounded-xl border bg-card p-8">
        <h2 className="text-lg font-semibold text-foreground">
          {session.title ?? 'Untitled session'}
        </h2>
        <div className="flex flex-wrap items-center justify-center gap-2 text-xs">
          <span className="rounded bg-secondary px-2 py-0.5 font-mono">
            {session.id.slice(0, 8)}
          </span>
          {session.model && (
            <span className="rounded bg-secondary px-2 py-0.5 font-mono">
              {session.model}
            </span>
          )}
          {session.surface && (
            <span className="rounded bg-secondary px-2 py-0.5">
              {session.surface}
            </span>
          )}
          <span className="rounded bg-secondary px-2 py-0.5">
            {session.mode}
          </span>
        </div>
        {session.cwd && (
          <p className="mt-1 font-mono text-xs">{session.cwd}</p>
        )}
        <p className="mt-4 max-w-sm text-center text-sm">
          Transcript viewer coming in Phase 2. Select a session to see its
          metadata here.
        </p>
      </div>
    </div>
  );
}
