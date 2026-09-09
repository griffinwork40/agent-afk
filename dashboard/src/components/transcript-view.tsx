import { cn } from '@/lib/utils';
import { AlertCircle, Info } from 'lucide-react';
import { MarkdownContent } from './markdown-content';
import { ThinkingPanel } from './thinking-panel';
import { ToolCallCard } from './tool-call-card';
import { SubagentCard } from './subagent-card';
import { SessionMeter } from './session-meter';

// Re-export so consumers import from one place.
export type { SessionTotals } from './session-meter';

export type TranscriptItem =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | { kind: 'thinking'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      toolUseId?: string;
      inputPreview: string;
      status: 'running' | 'ok' | 'error';
      output?: string;
      outputUnavailable?: boolean;
      diff?: string;
      durationMs?: number;
    }
  | { kind: 'error'; id: string; message: string }
  | { kind: 'notice'; id: string; text: string }
  | {
      kind: 'subagent';
      id: string;
      subagentId: string;
      status: string;
      label: string;
      model?: string;
      durationMs?: number;
      promptHead?: string;
    }
  | { kind: 'bg_job'; id: string; jobId: string; status: string; label: string };

import type { SessionTotals } from './session-meter';

interface TranscriptViewProps {
  items: TranscriptItem[];
  totals?: SessionTotals;
}

function UserMessage({ text }: { text: string }) {
  return (
    <div className="flex gap-2">
      <div className="w-0.5 shrink-0 rounded-full bg-brand" />
      <p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap">{text}</p>
    </div>
  );
}

function ErrorItem({ message }: { message: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-status-failed/40 bg-status-failed/5 px-3 py-2">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-failed" />
      <p className="text-sm text-status-failed">{message}</p>
    </div>
  );
}

function NoticeItem({ text }: { text: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border border-border bg-muted/40 px-3 py-2">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
      <p className="text-xs text-muted-foreground">{text}</p>
    </div>
  );
}

function BgJobItem({ item }: { item: Extract<TranscriptItem, { kind: 'bg_job' }> }) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 px-3 py-1.5">
      <span className="text-[10px] text-muted-foreground">BG</span>
      <span className="text-xs text-foreground">{item.label}</span>
      <span className={cn(
        'ml-auto font-mono text-[10px] capitalize',
        item.status === 'completed' ? 'text-status-running' : '',
        item.status === 'failed' ? 'text-status-failed' : '',
        item.status === 'running' ? 'text-status-blocked' : '',
      )}>{item.status}</span>
    </div>
  );
}

function renderItem(item: TranscriptItem): React.ReactNode {
  switch (item.kind) {
    case 'user':      return <UserMessage text={item.text} />;
    case 'assistant': return <MarkdownContent text={item.text} />;
    case 'thinking':  return <ThinkingPanel text={item.text} />;
    case 'tool':      return <ToolCallCard {...item} />;
    case 'error':     return <ErrorItem message={item.message} />;
    case 'notice':    return <NoticeItem text={item.text} />;
    case 'subagent':  return <SubagentCard {...item} />;
    case 'bg_job':    return <BgJobItem item={item} />;
  }
}

/** Root transcript container. Maps TranscriptItem[] to per-kind components. */
export function TranscriptView({ items, totals }: TranscriptViewProps) {
  return (
    <div className="flex flex-col gap-3">
      {totals && (
        <SessionMeter
          totals={totals}
          className="sticky top-0 z-10 rounded-md border border-border bg-card px-3 py-1.5"
        />
      )}
      {items.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          No transcript items yet.
        </p>
      ) : (
        items.map((item) => (
          <div key={item.id}>
            {renderItem(item)}
          </div>
        ))
      )}
    </div>
  );
}
