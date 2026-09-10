/**
 * SubagentTree — hierarchical subagent tree renderer.
 *
 * Renders a forest of SubagentTreeNodes as nested, collapsible cards using
 * Tailwind border connectors instead of ASCII art. Visual design mirrors the
 * dark-theme card aesthetic of ToolCallCard: bg-card, border-border.
 *
 * Contract: this file exports two surfaces:
 *   SubagentTree  — renders a root[] array (use at the transcript level)
 *   SubagentCard  — renders one root node and its subtree (backward compat)
 *
 * Collapse state is local to the component tree — React's own reconciler
 * preserves it between re-renders because node keys are stable subagentIds.
 */

import { useState } from 'react';
import { cn } from '@/lib/utils';
import {
  Play,
  CheckCircle,
  XCircle,
  Square,
  HelpCircle,
  ChevronRight,
} from 'lucide-react';
import type { SubagentTreeNode } from '@/hooks/use-subagent-tree';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.floor(s % 60)}s`;
}

function formatCost(usd: number): string {
  if (usd < 0.001) return '<$0.001';
  return `$${usd.toFixed(3)}`;
}

// ---------------------------------------------------------------------------
// Status icon
// ---------------------------------------------------------------------------

function StatusIcon({ status }: { status: string }) {
  const cls = 'h-3.5 w-3.5 shrink-0';
  switch (status) {
    case 'started':
      return <Play className={cn(cls, 'animate-pulse text-status-blocked')} aria-label="running" />;
    case 'succeeded':
    case 'completed':
      return <CheckCircle className={cn(cls, 'text-status-running')} aria-label="succeeded" />;
    case 'failed':
      return <XCircle className={cn(cls, 'text-status-failed')} aria-label="failed" />;
    case 'cancelled':
      return <Square className={cn(cls, 'text-muted-foreground')} aria-label="cancelled" />;
    default:
      return <HelpCircle className={cn(cls, 'text-muted-foreground')} aria-label="unknown" />;
  }
}

// ---------------------------------------------------------------------------
// Status color helper (for text)
// ---------------------------------------------------------------------------

function statusTextClass(status: string): string {
  switch (status) {
    case 'succeeded':
    case 'completed':
      return 'text-status-running';
    case 'failed':
      return 'text-status-failed';
    case 'started':
      return 'text-status-blocked';
    default:
      return 'text-muted-foreground';
  }
}

// ---------------------------------------------------------------------------
// Single node row
// ---------------------------------------------------------------------------

interface NodeRowProps {
  node: SubagentTreeNode;
  isExpanded: boolean;
  onToggle: () => void;
  /** True when this node is at depth > 0 (rendered inside a children block). */
  isChild: boolean;
}

function NodeRow({ node, isExpanded, onToggle, isChild }: NodeRowProps) {
  const { item } = node;
  const hasChildren = node.children.length > 0;

  return (
    <div
      className={cn(
        'flex items-start gap-2 px-3 py-2',
        hasChildren && 'cursor-pointer select-none',
        isChild && 'py-1.5',
      )}
      onClick={hasChildren ? onToggle : undefined}
      role={hasChildren ? 'button' : undefined}
      tabIndex={hasChildren ? 0 : undefined}
      onKeyDown={hasChildren ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); } } : undefined}
      aria-expanded={hasChildren ? isExpanded : undefined}
    >
      {/* Collapse toggle — only rendered when there are children */}
      {hasChildren ? (
        <ChevronRight
          className={cn(
            'mt-0.5 h-3 w-3 shrink-0 text-muted-foreground transition-transform',
            isExpanded && 'rotate-90',
          )}
        />
      ) : (
        /* Spacer to align with nodes that have a toggle */
        <span className="h-3 w-3 shrink-0" />
      )}

      {/* Status icon */}
      <span className="mt-0.5">
        <StatusIcon status={item.status} />
      </span>

      {/* Label block */}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          {/* Agent type or label */}
          <span className="text-xs font-medium text-foreground">
            {item.agentType ?? item.label}
          </span>

          {/* Model badge */}
          {item.model && (
            <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {item.model}
            </span>
          )}

          {/* Duration badge */}
          {item.durationMs !== undefined && (
            <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {formatDuration(item.durationMs)}
            </span>
          )}

          {/* Cost badge */}
          {item.totalCostUsd !== undefined && (
            <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
              {formatCost(item.totalCostUsd)}
            </span>
          )}

          {/* Status label — right-aligned */}
          <span className={cn('ml-auto font-mono text-[10px] capitalize', statusTextClass(item.status))}>
            {item.status}
          </span>
        </div>

        {/* Prompt head preview */}
        {item.promptHead && (
          <p className="mt-0.5 line-clamp-1 text-[11px] italic text-muted-foreground">
            &ldquo;{item.promptHead}&rdquo;
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recursive node renderer
// ---------------------------------------------------------------------------

interface SubagentNodeProps {
  node: SubagentTreeNode;
  isChild?: boolean;
}

function SubagentNode({ node, isChild = false }: SubagentNodeProps) {
  const [expanded, setExpanded] = useState(true);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <NodeRow
        node={node}
        isExpanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        isChild={isChild}
      />

      {/* Children — indented with a left border connector */}
      {hasChildren && expanded && (
        <div className="ml-6 border-l border-border/50 pl-3">
          {node.children.map((child, i) => (
            <div
              key={child.item.subagentId}
              className={cn(i < node.children.length - 1 && 'border-b border-border/30')}
            >
              <SubagentNode node={child} isChild />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Public exports
// ---------------------------------------------------------------------------

interface SubagentTreeProps {
  roots: SubagentTreeNode[];
  className?: string;
}

/**
 * Renders a forest of root subagent nodes as a collapsible tree.
 * Pass the output of useSubagentTree() directly.
 */
export function SubagentTree({ roots, className }: SubagentTreeProps) {
  if (roots.length === 0) return null;

  return (
    <div className={cn('rounded-md border border-border bg-card', className)}>
      {roots.map((root, i) => (
        <div
          key={root.item.subagentId}
          className={cn(i < roots.length - 1 && 'border-b border-border/50')}
        >
          <SubagentNode node={root} />
        </div>
      ))}
    </div>
  );
}

/**
 * Backward-compatible single-card wrapper for use in TranscriptView when a
 * node has no parentId (i.e., it IS a root from the caller's perspective).
 * Accepts a SubagentTreeNode so tree structure is preserved.
 */
export function SubagentCard({ node }: { node: SubagentTreeNode }) {
  return (
    <div className="rounded-md border border-border bg-card">
      <SubagentNode node={node} />
    </div>
  );
}
