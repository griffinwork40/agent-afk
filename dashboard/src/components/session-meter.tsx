import { cn } from '@/lib/utils';

export interface SessionTotals {
  costUsd: number;
  durationMs: number;
  turns: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
}

function Separator() {
  return <span className="text-muted-foreground/40" aria-hidden>·</span>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1">
      <span className="text-[10px] text-muted-foreground">{label}</span>
      <span className="font-mono text-xs text-foreground">{value}</span>
    </span>
  );
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

/** Compact top-bar metrics strip showing cost, tokens, duration. */
export function SessionMeter({ totals, className }: { totals?: SessionTotals; className?: string }) {
  if (!totals) {
    return (
      <div className={cn('flex items-center gap-2 text-xs text-muted-foreground', className)}>
        <span className="text-[10px] italic">No metrics yet</span>
      </div>
    );
  }

  const totalTokens =
    (totals.inputTokens ?? 0) +
    (totals.outputTokens ?? 0) +
    (totals.cacheReadTokens ?? 0);

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <Metric label="turns" value={String(totals.turns)} />
      <Separator />
      <Metric label="cost" value={`$${totals.costUsd.toFixed(4)}`} />
      {totalTokens > 0 && (
        <>
          <Separator />
          <Metric label="tokens" value={fmtTokens(totalTokens)} />
        </>
      )}
      <Separator />
      <Metric label="duration" value={fmtDuration(totals.durationMs)} />
    </div>
  );
}
