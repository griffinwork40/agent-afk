import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { AlertCircle, Info } from 'lucide-react';
import { MarkdownContent } from './markdown-content';
import { ThinkingPanel } from './thinking-panel';
import { ToolCallCard } from './tool-call-card';
import { SubagentTree } from './subagent-card';
import { SessionMeter } from './session-meter';
import { buildTree } from '@/hooks/use-subagent-tree';

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
      parentId?: string;
      status: string;
      label: string;
      model?: string;
      agentType?: string;
      durationMs?: number;
      totalCostUsd?: number;
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

// ---------------------------------------------------------------------------
// Subagent group rendering
// ---------------------------------------------------------------------------

/**
 * A "rendered slot" is either a non-subagent item or a contiguous run of
 * subagent items that should be displayed as a single tree block.
 *
 * Contract: subagent items that share the same parentage cluster naturally
 * because the ledger emits them in dispatch order. Grouping them into one
 * SubagentTree means parent→child relationships render correctly even when the
 * parent and child events appear in the same contiguous run.
 */
type Slot =
  | { kind: 'item'; item: TranscriptItem }
  | { kind: 'subagent-group'; items: Extract<TranscriptItem, { kind: 'subagent' }>[]; id: string };

function groupItems(items: TranscriptItem[]): Slot[] {
  const slots: Slot[] = [];
  let i = 0;

  while (i < items.length) {
    const item = items[i];
    if (item === undefined) { i++; continue; }

    if (item.kind !== 'subagent') {
      slots.push({ kind: 'item', item });
      i++;
      continue;
    }

    // Collect the contiguous subagent run.
    const subagentRun: Extract<TranscriptItem, { kind: 'subagent' }>[] = [];
    while (i < items.length) {
      const cur = items[i];
      if (cur === undefined || cur.kind !== 'subagent') break;
      subagentRun.push(cur as Extract<TranscriptItem, { kind: 'subagent' }>);
      i++;
    }

    // Use the first item's id as the stable group key.
    slots.push({ kind: 'subagent-group', items: subagentRun, id: subagentRun[0]!.id });
  }

  return slots;
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

/** Root transcript container. Maps TranscriptItem[] to per-kind components. */
export function TranscriptView({ items, totals }: TranscriptViewProps) {
  const slots = useMemo(() => groupItems(items), [items]);

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
        slots.map((slot) => {
          if (slot.kind === 'item') {
            const { item } = slot;
            return (
              <div key={item.id}>
                {renderNonSubagentItem(item)}
              </div>
            );
          }

          // Subagent group: build tree from the group then render.
          const roots = buildTree(slot.items);
          return (
            <SubagentTree key={slot.id} roots={roots} />
          );
        })
      )}
    </div>
  );
}

function renderNonSubagentItem(item: TranscriptItem): React.ReactNode {
  switch (item.kind) {
    case 'user':      return <UserMessage text={item.text} />;
    case 'assistant': return <MarkdownContent text={item.text} />;
    case 'thinking':  return <ThinkingPanel text={item.text} />;
    case 'tool':      return <ToolCallCard {...item} />;
    case 'error':     return <ErrorItem message={item.message} />;
    case 'notice':    return <NoticeItem text={item.text} />;
    case 'bg_job':    return <BgJobItem item={item} />;
    case 'subagent':  return null; // handled by groupItems above
  }
}
