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

/**
 * Compact header metrics strip: cost · tokens · duration.
 * Zeros are hidden — the meter is invisible until the first turn completes.
 * One instance lives in the app.tsx header only; the transcript no longer
 * renders a second sticky copy (P1-4 fix: metrics shown twice).
 */
export function SessionMeter({ totals, className }: { totals?: SessionTotals; className?: string }) {
  // Hide entirely when there are no meaningful values yet.
  if (!totals || (totals.costUsd === 0 && totals.durationMs === 0 && totals.turns === 0)) {
    return null;
  }

  const totalTokens =
    (totals.inputTokens ?? 0) +
    (totals.outputTokens ?? 0) +
    (totals.cacheReadTokens ?? 0);

  const parts: React.ReactNode[] = [];

  if (totals.turns > 0) {
    parts.push(<Metric key="turns" label="turns" value={String(totals.turns)} />);
  }

  if (totals.costUsd > 0) {
    if (parts.length > 0) parts.push(<Separator key="sep-cost" />);
    parts.push(<Metric key="cost" label="cost" value={`$${totals.costUsd.toFixed(4)}`} />);
  }

  if (totalTokens > 0) {
    if (parts.length > 0) parts.push(<Separator key="sep-tok" />);
    parts.push(<Metric key="tokens" label="tokens" value={fmtTokens(totalTokens)} />);
  }

  if (totals.durationMs > 0) {
    if (parts.length > 0) parts.push(<Separator key="sep-dur" />);
    parts.push(<Metric key="duration" label="duration" value={fmtDuration(totals.durationMs)} />);
  }

  if (parts.length === 0) return null;

  return (
    <div className={cn('flex flex-nowrap items-center gap-2 whitespace-nowrap', className)}>
      {parts}
    </div>
  );
}
