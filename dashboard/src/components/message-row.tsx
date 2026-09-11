import { cn } from '@/lib/utils';
import { AlertCircle, Info } from 'lucide-react';
import { MarkdownContent } from './markdown-content';
import { MessageActions } from './message-actions';
import type { TranscriptItem } from './transcript-view';

// ---------------------------------------------------------------------------
// UserMessage
// ---------------------------------------------------------------------------

/** Right-aligned user turn. No bubble — just label + plain text. */
export function UserMessage({ text }: { text: string }) {
  return (
    <div className="group relative flex flex-col items-end gap-1">
      <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/50">
        You
      </span>
      <p className="max-w-2xl text-sm leading-relaxed text-foreground whitespace-pre-wrap text-right">
        {text}
      </p>
      <MessageActions kind="user" text={text} />
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
export function AssistantRow({ text }: { text: string }) {
  return (
    <div className="group relative flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-widest text-brand/60">
        Agent
      </span>
      <div className="max-w-3xl">
        <MarkdownContent text={text} />
      </div>
      <MessageActions kind="assistant" text={text} />
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
