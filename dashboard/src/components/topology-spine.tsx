/**
 * TopologySpine — top-level spine container.
 *
 * Renders a forest of SpineNode roots as a vertical execution trace.
 * Each root is rendered by TopologyNode. The container adds a subtle
 * left border for visual continuity and a small section header.
 *
 * Contract: empty execution groups are omitted, including terminal notices.
 */

import { cn } from '@/lib/utils';
import { TopologyNode } from './topology-node';
import type { SpineNode } from '@/lib/topology-types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TopologySpineProps {
  nodes: SpineNode[];
  className?: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function TopologySpine({ nodes, className }: TopologySpineProps) {
  if (nodes.length === 0) return null;
  return (
    <div
      className={cn(
        'relative pl-3 border-l-2 border-spine/40',
        className,
      )}
    >
      {/* Section header — text-foreground/60 (~AA at 10px bold on dark bg) */}
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-widest text-foreground/60 select-none">
        Execution
      </div>

      {/* Tree roots */}
      <div className="flex flex-col gap-0.5">
        {nodes.map((node, idx) => (
          <TopologyNode
            key={node.id}
            node={node}
            depth={0}
            isLast={idx === nodes.length - 1}
          />
        ))}
      </div>
    </div>
  );
}
