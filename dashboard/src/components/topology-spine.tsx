/**
 * TopologySpine — top-level spine container.
 *
 * Renders a forest of SpineNode roots as a vertical execution trace.
 * Each root is rendered by TopologyNode. The container adds a subtle
 * left border for visual continuity and a small section header.
 *
 * Contract: an empty `nodes` array renders the header but no tree rows —
 * callers decide whether to hide the whole panel when there is nothing to show.
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
  return (
    <div
      className={cn(
        'relative pl-3 border-l-2 border-spine/40',
        className,
      )}
    >
      {/* Section header */}
      <div className="mb-1 text-[10px] uppercase tracking-widest text-muted-foreground/40 select-none">
        Execution
      </div>

      {/* Tree roots */}
      {nodes.length === 0 ? (
        <div className="text-[11px] text-muted-foreground/30 italic py-1">
          No activity yet
        </div>
      ) : (
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
      )}
    </div>
  );
}
