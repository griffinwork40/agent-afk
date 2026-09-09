import { cn } from '@/lib/utils';
import { DiffViewer } from './diff-viewer';

type Status = 'running' | 'ok' | 'error';

interface ToolCallCardProps {
  name: string;
  inputPreview: string;
  status: Status;
  output?: string;
  outputUnavailable?: boolean;
  diff?: string;
  durationMs?: number;
}

function StatusDot({ status }: { status: Status }) {
  return (
    <span
      className={cn(
        'mt-0.5 inline-block h-2 w-2 shrink-0 rounded-full',
        status === 'ok' && 'bg-status-running',
        status === 'error' && 'bg-status-failed',
        status === 'running' && 'animate-pulse bg-status-blocked',
      )}
      aria-label={status}
    />
  );
}

function DurationBadge({ ms }: { ms: number }) {
  const s = (ms / 1000).toFixed(1);
  return (
    <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
      {s}s
    </span>
  );
}

/** Collapsible card for a single tool invocation. */
export function ToolCallCard({
  name,
  inputPreview,
  status,
  output,
  outputUnavailable,
  diff,
  durationMs,
}: ToolCallCardProps) {
  const hasOutput = diff || outputUnavailable || (output && output.trim().length > 0);

  return (
    <div className={cn(
      'rounded-md border bg-card',
      status === 'error' ? 'border-status-failed/40' : 'border-border',
    )}>
      {/* Header — always visible */}
      <div className="flex items-start gap-2 px-3 py-2">
        <StatusDot status={status} />
        <span className="font-mono text-xs font-medium text-foreground">{name}</span>
        {durationMs !== undefined && (
          <span className="ml-auto"><DurationBadge ms={durationMs} /></span>
        )}
      </div>

      {/* Input preview — always visible, truncated */}
      {inputPreview.trim().length > 0 && (
        <div className="border-t border-border/50 px-3 py-1.5">
          <p className="line-clamp-2 font-mono text-[11px] text-muted-foreground">
            {inputPreview}
          </p>
        </div>
      )}

      {/* Output — collapsible via <details> */}
      {hasOutput && (
        <details className="group border-t border-border/50">
          <summary className="flex cursor-pointer list-none items-center gap-1 px-3 py-1.5 text-[11px] text-muted-foreground select-none hover:text-foreground">
            <span className="inline-block transition-transform group-open:rotate-90">▶</span>
            Output
          </summary>
          <div className="px-3 pb-2 pt-1">
            {outputUnavailable && (
              <p className="text-[11px] italic text-muted-foreground">
                Output not available (replayed session)
              </p>
            )}
            {diff && <DiffViewer diff={diff} />}
            {!diff && output && (
              <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] text-foreground">
                {output}
              </pre>
            )}
          </div>
        </details>
      )}
    </div>
  );
}
