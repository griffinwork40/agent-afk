import { cn } from '@/lib/utils';
import {
  Play,
  CheckCircle,
  XCircle,
  Square,
  HelpCircle,
} from 'lucide-react';

interface SubagentCardProps {
  subagentId: string;
  status: string;
  label: string;
  model?: string;
  durationMs?: number;
  promptHead?: string;
}

function StatusIcon({ status }: { status: string }) {
  const cls = 'h-4 w-4 shrink-0';
  switch (status) {
    case 'started':
      return <Play className={cn(cls, 'text-status-blocked')} />;
    case 'succeeded':
    case 'completed':
      return <CheckCircle className={cn(cls, 'text-status-running')} />;
    case 'failed':
      return <XCircle className={cn(cls, 'text-status-failed')} />;
    case 'cancelled':
      return <Square className={cn(cls, 'text-muted-foreground')} />;
    default:
      return <HelpCircle className={cn(cls, 'text-muted-foreground')} />;
  }
}

/** Renders a subagent lifecycle event as a compact tree-style card. */
export function SubagentCard({
  subagentId,
  status,
  label,
  model,
  durationMs,
  promptHead,
}: SubagentCardProps) {
  const durationLabel =
    durationMs !== undefined ? `${(durationMs / 1000).toFixed(1)}s` : null;

  return (
    <div className="flex gap-2 rounded-md border border-border bg-card px-3 py-2">
      {/* Left spine */}
      <div className="flex flex-col items-center pt-0.5">
        <StatusIcon status={status} />
        {/* Vertical connector line */}
        <div className="mt-1 flex-1 border-l border-dashed border-border/50" />
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1 space-y-1">
        {/* Label + badges row */}
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium text-foreground">{label}</span>
          {model && (
            <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {model}
            </span>
          )}
          {durationLabel && (
            <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {durationLabel}
            </span>
          )}
          <span className={cn(
            'ml-auto text-[10px] font-mono capitalize',
            status === 'succeeded' || status === 'completed' ? 'text-status-running' : '',
            status === 'failed' ? 'text-status-failed' : '',
            status === 'started' ? 'text-status-blocked' : '',
            status === 'cancelled' ? 'text-muted-foreground' : '',
          )}>
            {status}
          </span>
        </div>

        {/* Subagent ID */}
        <p className="truncate font-mono text-[10px] text-muted-foreground/70" title={subagentId}>
          {subagentId}
        </p>

        {/* Prompt head preview */}
        {promptHead && (
          <p className="line-clamp-1 text-[11px] italic text-muted-foreground">
            "{promptHead}"
          </p>
        )}
      </div>
    </div>
  );
}
