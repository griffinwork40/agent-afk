import { useMemo, useCallback } from 'react';
import { ThinkingPanel } from './thinking-panel';
import { ToolCallCard } from './tool-call-card';
import { SubagentTree } from './subagent-card';
import { SessionMeter } from './session-meter';
import { buildTree } from '@/hooks/use-subagent-tree';
import { SpineTranscript, useSpineSlots } from './transcript-spine';
import {
  UserMessage,
  AssistantRow,
  ErrorItem,
  NoticeItem,
  BgJobItem,
} from './message-row';

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
      turnCount?: number;
      stopReason?: string;
      parentToolUseId?: string;
    }
  | { kind: 'bg_job'; id: string; jobId: string; status: string; label: string };

import type { SessionTotals } from './session-meter';

interface TranscriptViewProps {
  items: TranscriptItem[];
  totals?: SessionTotals;
  /** When true, render execution blocks as topology spine trees. */
  spineMode?: boolean;
  /** When true, the last assistant message is actively streaming. */
  turnActive?: boolean;
}

// ---------------------------------------------------------------------------
// Legacy flat grouping (subagent-only groups)
// ---------------------------------------------------------------------------

type Slot =
  | { kind: 'item'; item: TranscriptItem }
  | { kind: 'subagent-group'; items: Extract<TranscriptItem, { kind: 'subagent' }>[]; id: string };

export function groupItems(items: TranscriptItem[]): Slot[] {
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

    const subagentRun: Extract<TranscriptItem, { kind: 'subagent' }>[] = [];
    while (i < items.length) {
      const cur = items[i];
      if (cur === undefined || cur.kind !== 'subagent') break;
      subagentRun.push(cur as Extract<TranscriptItem, { kind: 'subagent' }>);
      i++;
    }

    slots.push({ kind: 'subagent-group', items: subagentRun, id: subagentRun[0]!.id });
  }

  return slots;
}

// ---------------------------------------------------------------------------
// Shared item renderer (text items only in spine mode, all in flat mode)
// ---------------------------------------------------------------------------

export function renderNonSubagentItem(item: TranscriptItem, isStreaming = false): React.ReactNode {
  switch (item.kind) {
    case 'user':      return <UserMessage text={item.text} />;
    case 'assistant': return <AssistantRow text={item.text} isStreaming={isStreaming} />;
    case 'thinking':  return <ThinkingPanel text={item.text} />;
    case 'tool':      return <ToolCallCard {...item} />;
    case 'error':     return <ErrorItem message={item.message} />;
    case 'notice':    return <NoticeItem text={item.text} />;
    case 'bg_job':    return <BgJobItem item={item} />;
    case 'subagent':  return null;
  }
}

function renderTextItem(item: TranscriptItem, isStreaming = false): React.ReactNode {
  switch (item.kind) {
    case 'user':      return <UserMessage text={item.text} />;
    case 'assistant': return <AssistantRow text={item.text} isStreaming={isStreaming} />;
    case 'thinking':  return <ThinkingPanel text={item.text} />;
    case 'error':     return <ErrorItem message={item.message} />;
    case 'notice':    return <NoticeItem text={item.text} />;
    case 'bg_job':    return <BgJobItem item={item} />;
    default:          return null;
  }
}

// ---------------------------------------------------------------------------
// Main view
// ---------------------------------------------------------------------------

/** Root transcript container. Maps TranscriptItem[] to per-kind components. */
export function TranscriptView({ items, totals, spineMode = true, turnActive = false }: TranscriptViewProps) {
  const flatSlots = useMemo(() => groupItems(items), [items]);
  const spineSlots = useSpineSlots(items);

  // Find the id of the last assistant item — only that one gets streaming animation.
  const lastAssistantId = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i]?.kind === 'assistant') return items[i]!.id;
    }
    return null;
  }, [items]);

  const renderSpineTextItem = useCallback(
    (item: TranscriptItem, idx: number) => {
      const isTurnStart = item.kind === 'user' && idx > 0;
      const streaming = turnActive && item.id === lastAssistantId;
      return (
        <div key={item.id}>
          {isTurnStart && (
            <div className="my-6 border-t border-border/40" aria-hidden="true" />
          )}
          <div className="py-2 px-1">{renderTextItem(item, streaming)}</div>
        </div>
      );
    },
    [turnActive, lastAssistantId],
  );

  return (
    <div className="flex flex-col gap-0 max-w-4xl mx-auto w-full">
      {totals && (
        <SessionMeter
          totals={totals}
          className="sticky top-0 z-10 mb-4 rounded-md border border-border bg-card px-3 py-1.5"
        />
      )}
      {items.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          No transcript items yet.
        </p>
      ) : spineMode ? (
        <SpineTranscript slots={spineSlots} renderTextItem={renderSpineTextItem} />
      ) : (
        flatSlots.map((slot, idx) => {
          if (slot.kind === 'item') {
            const { item } = slot;
            const isTurnStart = item.kind === 'user' && idx > 0;
            const streaming = turnActive && item.id === lastAssistantId;
            return (
              <div key={item.id}>
                {isTurnStart && (
                  <div className="my-6 border-t border-border/40" aria-hidden="true" />
                )}
                <div className="py-2 px-1">
                  {renderNonSubagentItem(item, streaming)}
                </div>
              </div>
            );
          }
          const roots = buildTree(slot.items);
          return (
            <div key={slot.id} className="py-2 px-1">
              <SubagentTree roots={roots} />
            </div>
          );
        })
      )}
    </div>
  );
}
