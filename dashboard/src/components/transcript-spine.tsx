/**
 * Spine-enhanced transcript rendering.
 *
 * Groups contiguous tool + subagent items into topology spine trees,
 * keeping text items (user, assistant, thinking, error, notice) as-is.
 * This replaces the flat tool-card + subagent-card rendering with
 * a hierarchical execution view.
 */
import { useMemo } from 'react';
import type { TranscriptItem } from './transcript-view';
import { TopologySpine } from './topology-spine';
import { buildSpineTree } from '@/lib/topology';
import type { SpineNode } from '@/lib/topology-types';

// Items that represent execution (grouped into spine blocks).
// 'notice' is included so that activity notices between a tool call and its
// dispatched subagent do not break the contiguous execution run. The tree
// builder filters by kind === 'tool' | 'subagent', so notices pass through
// harmlessly without affecting topology linking.
const EXECUTION_KINDS = new Set(['tool', 'subagent', 'notice']);

// Items that are prose/text (rendered individually)
const TEXT_KINDS = new Set(['user', 'assistant', 'thinking', 'error', 'notice', 'bg_job']);

/**
 * A rendered slot is either a single text item or a group of execution
 * items that should render as a topology spine.
 */
type SpineSlot =
  | { kind: 'text'; item: TranscriptItem }
  | { kind: 'execution'; items: TranscriptItem[]; id: string; spineNodes: SpineNode[] };

/**
 * Group transcript items into spine slots. Contiguous runs of tool +
 * subagent items are merged into a single execution block and fed
 * through the topology tree builder.
 */
export function groupIntoSpineSlots(items: TranscriptItem[]): SpineSlot[] {
  const slots: SpineSlot[] = [];
  let i = 0;

  while (i < items.length) {
    const item = items[i];
    if (item === undefined) { i++; continue; }

    if (TEXT_KINDS.has(item.kind)) {
      slots.push({ kind: 'text', item });
      i++;
      continue;
    }

    // Collect contiguous execution items (tools + subagents).
    const run: TranscriptItem[] = [];
    while (i < items.length) {
      const cur = items[i];
      if (cur === undefined || !EXECUTION_KINDS.has(cur.kind)) break;
      run.push(cur);
      i++;
    }

    if (run.length > 0) {
      const spineNodes = buildSpineTree(run);
      slots.push({
        kind: 'execution',
        items: run,
        id: run[0]!.id,
        spineNodes,
      });
    }
  }

  return slots;
}

interface SpineTranscriptProps {
  slots: SpineSlot[];
  renderTextItem: (item: TranscriptItem, idx: number) => React.ReactNode;
}

/**
 * Render transcript items with spine-grouped execution blocks.
 * Text items are rendered via the provided callback; execution blocks
 * are rendered as TopologySpine components.
 */
export function SpineTranscript({ slots, renderTextItem }: SpineTranscriptProps) {
  return (
    <>
      {slots.map((slot, idx) => {
        if (slot.kind === 'text') {
          return renderTextItem(slot.item, idx);
        }
        return (
          <div key={slot.id} className="py-2 px-1">
            <TopologySpine nodes={slot.spineNodes} />
          </div>
        );
      })}
    </>
  );
}

/**
 * Hook to compute spine slots from transcript items.
 * Memoized to avoid recomputing on every render.
 */
export function useSpineSlots(items: TranscriptItem[]): SpineSlot[] {
  return useMemo(() => groupIntoSpineSlots(items), [items]);
}
