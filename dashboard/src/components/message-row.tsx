import { cn } from '@/lib/utils';
import { AlertCircle, Info, OctagonX } from 'lucide-react';
import { MarkdownContent } from './markdown-content';
import { StreamingText } from './streaming-text';
import { MessageActions } from './message-actions';
import type { TranscriptItem } from '@/lib/ledger-adapter';

// ---------------------------------------------------------------------------
// UserMessage
// ---------------------------------------------------------------------------

/**
 * Left-aligned user turn with a subtle bubble.
 *
 * P1-8: bubble replaces bare right-aligned text; left-aligned text inside the
 * bubble is more readable and avoids ragged right-alignment on long messages.
 * P1-9: "YOU" label uses text-muted-foreground (not /50) to pass WCAG AA
 * contrast (was 2.15 against #0d1117; muted-foreground gives ≥4.5).
 */
export function UserMessage({
  text,
  ts,
  onEdit,
  isBusy,
}: {
  text: string;
  ts?: number;
  onEdit?: (text: string) => void;
  isBusy?: boolean;
}) {
  return (
    <div className="group relative flex flex-col items-start gap-1">
      <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground">
        You
      </span>
      <div className="max-w-xl rounded-xl bg-secondary/70 px-4 py-2.5 border border-border/50">
        <p className="text-[15px] leading-relaxed text-foreground whitespace-pre-wrap">
          {text}
        </p>
      </div>
      <MessageActions kind="user" text={text} ts={ts} onEdit={onEdit} isBusy={isBusy} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// AssistantRow
// ---------------------------------------------------------------------------

/**
 * Left-aligned assistant turn. Full-width prose column capped at max-w-3xl.
 * Renders content via MarkdownContent for proper GFM support.
 */
export function AssistantRow({
  text,
  ts,
  isStreaming = false,
  onRetry,
  isBusy,
}: {
  text: string;
  ts?: number;
  isStreaming?: boolean;
  onRetry?: () => void;
  isBusy?: boolean;
}) {
  return (
    <div className="group relative flex flex-col gap-1">
      {/* P1-9: text-brand/80 gives ≥4.5:1 contrast on dark bg (was /60 = ~3.1). */}
      <span className="text-[11px] font-medium uppercase tracking-widest text-brand/80">
        Agent
      </span>
      <div className="max-w-3xl">
        {isStreaming ? (
          <StreamingText text={text} isStreaming={true} />
        ) : (
          <MarkdownContent text={text} />
        )}
      </div>
      <MessageActions kind="assistant" text={text} ts={ts} onRetry={onRetry} isBusy={isBusy} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ErrorItem
// ---------------------------------------------------------------------------

/** Destructive-tinted card for runtime errors surfaced in the transcript. */
export function ErrorItem({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-failed" />
      <p className="text-sm leading-relaxed text-status-failed">{message}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// NoticeItem
// ---------------------------------------------------------------------------

/** Compact muted info row for system notices. */
export function NoticeItem({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <p className="text-xs text-muted-foreground">{text}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StoppedItem
// ---------------------------------------------------------------------------

/**
 * Amber-tinted row shown after a user-interrupted turn.
 * Replaces the generic "turn complete" notice so the user knows the turn
 * was stopped, not finished naturally.
 */
export function StoppedItem({ text, onRetry, isBusy }: { text: string; onRetry?: () => void; isBusy?: boolean }) {
  return (
    <div data-testid="stopped-item" className="flex items-center gap-2.5 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-2.5">
      <OctagonX className="h-3.5 w-3.5 shrink-0 text-amber-500" />
      <p className="flex-1 text-xs text-amber-600 dark:text-amber-400">{text}</p>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={isBusy}
          className={cn(
            'rounded px-2 py-0.5 text-[11px] font-medium',
            'border border-amber-500/30 text-amber-600 dark:text-amber-400',
            'hover:bg-amber-500/10 transition-colors',
            'disabled:opacity-40 disabled:cursor-not-allowed',
          )}
        >
          Retry
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// BgJobItem
// ---------------------------------------------------------------------------

/** Compact background-job status row. Keeps the existing design. */
export function BgJobItem({ item }: { item: Extract<TranscriptItem, { kind: 'bg_job' }> }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5">
      <span className="text-[10px] text-muted-foreground">BG</span>
      <span className="text-xs text-foreground">{item.label}</span>
      <span
        className={cn(
          'ml-auto font-mono text-[10px] capitalize',
          item.status === 'completed' ? 'text-status-running' : '',
          item.status === 'failed' ? 'text-status-failed' : '',
          item.status === 'running' ? 'text-status-blocked' : '',
        )}
      >
        {item.status}
      </span>
    </div>
  );
}
