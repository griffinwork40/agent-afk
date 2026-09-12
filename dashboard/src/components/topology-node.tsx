/**
 * TopologyNode — recursive spine node renderer.
 *
 * Renders one SpineNode and its children using div-based tree connectors.
 * Tree structure:
 *   [connector] [icon] [label] [badges] [duration]
 *               [children indented under vertical spine line]
 *
 * Contract: children are always rendered; collapse only applies to agent
 * nodes whose `isActive` is false. Root and tool nodes are always expanded.
 */

import { useState } from 'react';
import {
  FileSearch,
  FilePen,
  Terminal,
  GitBranch,
  Sparkles,
  Network,
  Plug,
  ExternalLink,
  Globe,
  ListTodo,
  Wrench,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { formatSpineDuration, formatSpineCost } from '@/lib/topology';
import type { SpineNode, ToolCategory } from '@/lib/topology-types';

// ---------------------------------------------------------------------------
// Category icon map
// ---------------------------------------------------------------------------

const CATEGORY_ICON: Record<ToolCategory, React.ElementType> = {
  read:    FileSearch,
  write:   FilePen,
  shell:   Terminal,
  agent:   GitBranch,
  skill:   Sparkles,
  dag:     Network,
  mcp:     Plug,
  web:     ExternalLink,
  browser: Globe,
  plan:    ListTodo,
  other:   Wrench,
};

const CATEGORY_COLOR: Record<ToolCategory, string> = {
  read:    'text-cat-read',
  write:   'text-cat-write',
  shell:   'text-cat-shell',
  agent:   'text-cat-agent',
  skill:   'text-cat-skill',
  dag:     'text-cat-dag',
  mcp:     'text-cat-mcp',
  web:     'text-cat-web',
  browser: 'text-cat-browser',
  plan:    'text-cat-plan',
  other:   'text-cat-other',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countDescendantTools(node: SpineNode): number {
  let count = 0;
  for (const child of node.children) {
    if (child.kind === 'tool') count++;
    count += countDescendantTools(child);
  }
  return count;
}

function sumDescendantDuration(node: SpineNode): number {
  let total = node.durationMs ?? 0;
  for (const child of node.children) {
    total += sumDescendantDuration(child);
  }
  return total;
}

// ---------------------------------------------------------------------------
// NodeIcon — icon with status-driven styling
// ---------------------------------------------------------------------------

interface NodeIconProps {
  category: ToolCategory;
  status: SpineNode['status'];
}

function NodeIcon({ category, status }: NodeIconProps) {
  const Icon = CATEGORY_ICON[category];
  const colorClass = CATEGORY_COLOR[category];
  return (
    <Icon
      className={cn(
        'h-3.5 w-3.5 shrink-0',
        colorClass,
        status === 'running'   && 'animate-shimmer-pulse',
        status === 'error'     && 'text-status-failed',
        status === 'cancelled' && 'opacity-50',
      )}
      aria-hidden
    />
  );
}

// ---------------------------------------------------------------------------
// CloserLine — summary footer for completed agent nodes
// ---------------------------------------------------------------------------

interface CloserLineProps {
  node: SpineNode;
}

function CloserLine({ node }: CloserLineProps) {
  if (node.status === 'running' || node.children.length === 0) return null;

  if (node.status === 'error') {
    return (
      <div className="mt-0.5 pl-5 text-[11px] text-status-failed">
        Failed
      </div>
    );
  }

  if (node.status === 'cancelled') {
    return (
      <div className="mt-0.5 pl-5 text-[11px] text-muted-foreground">
        Cancelled
      </div>
    );
  }

  const toolCount = countDescendantTools(node);
  const totalMs   = node.durationMs ?? sumDescendantDuration(node);
  const costUsd   = node.costUsd;

  const parts: string[] = [];
  if (toolCount > 0) parts.push(`${toolCount} tool${toolCount !== 1 ? 's' : ''}`);
  if (totalMs > 0)   parts.push(formatSpineDuration(totalMs));
  if (costUsd != null && costUsd > 0) parts.push(formatSpineCost(costUsd));

  return (
    <div className="mt-0.5 pl-5 text-[11px] text-muted-foreground">
      Done{parts.length > 0 ? ` (${parts.join(' · ')})` : ''}
    </div>
  );
}

// ---------------------------------------------------------------------------
// TopologyNode — one node + its subtree
// ---------------------------------------------------------------------------

export interface TopologyNodeProps {
  node: SpineNode;
  /** Depth for indentation; root nodes start at 0. */
  depth?: number;
  /** True when this is the last child in its parent's list. */
  isLast?: boolean;
}

export function TopologyNode({ node, depth = 0, isLast: _isLast = false }: TopologyNodeProps) {
  // Agent nodes with children are collapsible.
  // Default: expanded when active, collapsed when done.
  const isCollapsible = node.kind === 'agent' && node.children.length > 0;
  const [expanded, setExpanded] = useState<boolean>(node.isActive);

  const hasChildren = node.children.length > 0;
  const isAgent = node.kind === 'agent';

  // Chevron for collapsible agent nodes
  const ChevronIcon = expanded ? ChevronDown : ChevronRight;

  return (
    <div className={cn('relative', depth > 0 && 'pl-3')}>
      {/* ── Header row ─────────────────────────────────────── */}
      <div
        className={cn(
          'flex items-center gap-1.5 py-0.5 group',
          isCollapsible && 'cursor-pointer select-none',
        )}
        onClick={isCollapsible ? () => setExpanded(e => !e) : undefined}
        role={isCollapsible ? 'button' : undefined}
        aria-expanded={isCollapsible ? expanded : undefined}
      >
        {/* Collapse chevron — only on collapsible agent nodes */}
        {isCollapsible ? (
          <ChevronIcon className="h-3 w-3 shrink-0 text-muted-foreground/50" />
        ) : (
          <span className="h-3 w-3 shrink-0" aria-hidden />
        )}

        {/* Category icon with status styling */}
        <NodeIcon category={node.category} status={node.status} />

        {/* Label */}
        <span
          className={cn(
            'text-[12px] font-mono leading-none',
            node.status === 'cancelled' && 'opacity-50',
            node.status === 'error'     && 'text-status-failed',
            node.status === 'running'   && 'text-foreground',
            node.status === 'ok'        && 'text-foreground/80',
          )}
        >
          {node.label}
        </span>

        {/* ── Badges ── */}

        {/* Model badge (agents only) */}
        {isAgent && node.model && (
          <span className="bg-secondary rounded px-1 py-0.5 text-[10px] font-mono text-muted-foreground">
            {node.model}
          </span>
        )}

        {/* Agent type badge */}
        {isAgent && node.agentType && (
          <span className="bg-secondary rounded px-1 py-0.5 text-[10px] font-mono text-muted-foreground">
            {node.agentType}
          </span>
        )}

        {/* Turn count */}
        {isAgent && node.turnCount != null && node.turnCount > 0 && (
          <span className="text-[10px] font-mono text-muted-foreground">
            {node.turnCount} turn{node.turnCount !== 1 ? 's' : ''}
          </span>
        )}

        {/* Duration */}
        {node.durationMs != null && node.durationMs > 0 && (
          <span className="text-[10px] font-mono text-muted-foreground tabular-nums">
            {formatSpineDuration(node.durationMs)}
          </span>
        )}

        {/* Cost (agents only) */}
        {isAgent && node.costUsd != null && node.costUsd > 0 && (
          <span className="text-[10px] font-mono text-muted-foreground">
            {formatSpineCost(node.costUsd)}
          </span>
        )}
      </div>

      {/* ── Preview line (agents only) ─────────────────────── */}
      {isAgent && node.preview && (
        <div className="pl-5 text-[11px] italic text-muted-foreground/60 line-clamp-1 leading-tight">
          {node.preview}
        </div>
      )}

      {/* ── Closer summary (completed agents with children) ── */}
      {isAgent && !expanded && hasChildren && (
        <CloserLine node={node} />
      )}

      {/* ── Children subtree ───────────────────────────────── */}
      {hasChildren && expanded && (
        <div
          className={cn(
            'relative mt-0.5 ml-[22px]',
            // Vertical spine line down the left of the children block.
            // The line stops short of the last child's connector.
            'border-l-2 border-spine',
          )}
        >
          {node.children.map((child, idx) => {
            const childIsLast = idx === node.children.length - 1;
            return (
              <div key={child.id} className="relative">
                {/* Horizontal connector stub from the spine to the child */}
                <div
                  className={cn(
                    'absolute left-0 top-[10px] h-0 w-3',
                    'border-t-2 border-spine',
                    // For the last child, clip the vertical spine at the connector.
                    // We do this by overlaying a background-colored block below the connector.
                    childIsLast && 'last-child-clip',
                  )}
                  aria-hidden
                />
                {/* For the last child: hide the vertical line below the connector */}
                {childIsLast && (
                  <div
                    className="absolute left-[-2px] top-[10px] bottom-0 w-[2px] bg-background"
                    aria-hidden
                  />
                )}
                <div className="pl-3">
                  <TopologyNode
                    node={child}
                    depth={depth + 1}
                    isLast={childIsLast}
                  />
                </div>
              </div>
            );
          })}
          {/* Closer line shown when expanded and agent is done */}
          {isAgent && node.status !== 'running' && (
            <CloserLine node={node} />
          )}
        </div>
      )}

      {/* Closer for collapsed agents (no children rendered) */}
      {isAgent && (!hasChildren || !expanded) && node.status !== 'running' && (
        !hasChildren ? <CloserLine node={node} /> : null
      )}
    </div>
  );
}
