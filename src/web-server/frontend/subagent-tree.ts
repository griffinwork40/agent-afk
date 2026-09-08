/**
 * Subagent tree panel for the AFK web UI.
 *
 * Consumes `subagent_lifecycle` ledger events and renders a collapsible tree
 * showing each subagent's status, model, agentType, promptHead, duration, and
 * cost. Children are indented under their parents with connecting lines that
 * mirror the TUI tool-lane spine aesthetic.
 *
 * Invariant: this module owns state (SubagentTreeState) and rendering
 * (renderSubagentTree) but intentionally carries NO knowledge of how or when
 * it is wired into the page — that is Wave 2-Beta's responsibility. Do NOT
 * import render.ts or app.ts from here.
 */

// ── Public interface ──────────────────────────────────────────────────────────

export interface SubagentNode {
  id: string;
  parentId?: string;
  model?: string;
  agentType?: string;
  status: string;
  durationMs?: number;
  totalCostUsd?: number;
  promptHead?: string;
  children: SubagentNode[];
}

// ── State ─────────────────────────────────────────────────────────────────────

/** Accepted shape for a single `subagent_lifecycle` ledger event. */
export interface SubagentLifecycleEvent {
  subagentId: string;
  status: string;
  parentId?: string;
  model?: string;
  agentType?: string;
  durationMs?: number;
  totalCostUsd?: number;
  promptHead?: string;
}

/**
 * Maintains a live tree of subagent nodes built from lifecycle events.
 *
 * Contract: events arrive in chronological order; the same subagentId can
 * appear multiple times (started → succeeded/failed/cancelled). Each call to
 * `addEvent` upserts: it creates the node on the first occurrence and patches
 * mutable fields (status, durationMs, totalCostUsd) on subsequent ones.
 */
export class SubagentTreeState {
  // History: using a Map<id, node> rather than a bare array because lookups
  // by subagentId are the dominant operation (upsert on every event, parent
  // lookup when attaching children). Array scans on every event would be O(n²)
  // across a long session with many subagents.
  readonly #nodes = new Map<string, SubagentNode>();
  readonly #roots: SubagentNode[] = [];

  addEvent(event: SubagentLifecycleEvent): void {
    const existing = this.#nodes.get(event.subagentId);

    if (existing) {
      // Patch mutable fields that arrive on terminal events (succeeded/failed).
      existing.status = event.status;
      if (event.durationMs !== undefined) existing.durationMs = event.durationMs;
      if (event.totalCostUsd !== undefined) existing.totalCostUsd = event.totalCostUsd;
      // model, agentType, promptHead are set on creation and never change.
      return;
    }

    const node: SubagentNode = {
      id: event.subagentId,
      parentId: event.parentId,
      model: event.model,
      agentType: event.agentType,
      status: event.status,
      durationMs: event.durationMs,
      totalCostUsd: event.totalCostUsd,
      promptHead: event.promptHead,
      children: [],
    };

    this.#nodes.set(node.id, node);

    if (node.parentId) {
      const parent = this.#nodes.get(node.parentId);
      if (parent) {
        parent.children.push(node);
      } else {
        // Parent not yet seen — treat as root until a parent event arrives.
        // This handles out-of-order replay; a second pass would be needed to
        // fully re-parent orphans, but in practice lifecycle events for the
        // parent always arrive before children because the parent starts first.
        this.#roots.push(node);
      }
    } else {
      this.#roots.push(node);
    }
  }

  getRoots(): SubagentNode[] {
    return this.#roots;
  }
}

// ── Rendering helpers ─────────────────────────────────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * Maps a lifecycle status to a display icon.
 *
 * Contract: the spinning animation for 'started' is pure CSS; this function
 * returns the element with the right class — animation is defined in styles.css.
 */
function statusIcon(status: string): HTMLElement {
  const span = el('span', 'sat-icon');
  switch (status) {
    case 'started':
      span.classList.add('sat-icon-started');
      span.setAttribute('aria-label', 'running');
      span.textContent = '●';
      break;
    case 'succeeded':
      span.classList.add('sat-icon-succeeded');
      span.setAttribute('aria-label', 'succeeded');
      span.textContent = '✓';
      break;
    case 'failed':
      span.classList.add('sat-icon-failed');
      span.setAttribute('aria-label', 'failed');
      span.textContent = '✗';
      break;
    case 'cancelled':
      span.classList.add('sat-icon-cancelled');
      span.setAttribute('aria-label', 'cancelled');
      span.textContent = '–';
      break;
    default:
      span.textContent = '?';
  }
  return span;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.floor(s % 60)}s`;
}

function formatCost(usd: number): string {
  if (usd < 0.001) return `<$0.001`;
  return `$${usd.toFixed(3)}`;
}

/**
 * Build the label row for a single node.
 *
 * Layout: [connector] [icon] [agentType (model)] [promptHead...] [duration] [$cost]
 */
function buildRow(node: SubagentNode, depth: number, isLast: boolean): HTMLElement {
  const row = el('div', 'sat-row');
  row.dataset['id'] = node.id;

  // Tree connector indentation
  if (depth > 0) {
    const indent = el('span', 'sat-indent');
    // Each level gets a connector segment; the last child uses a corner (└)
    // whereas siblings use a tee (├). We emit the spine for ancestor levels
    // by repeating the vertical bar character for depth-1 levels.
    indent.textContent = '  '.repeat(depth - 1) + (isLast ? '└ ' : '├ ');
    row.appendChild(indent);
  }

  row.appendChild(statusIcon(node.status));

  const label = el('span', 'sat-label');

  const typeSpan = el('span', 'sat-type', node.agentType ?? 'subagent');
  label.appendChild(typeSpan);

  if (node.model) {
    label.appendChild(el('span', 'sat-model', ` (${node.model})`));
  }

  if (node.promptHead) {
    const head = node.promptHead.length > 60
      ? node.promptHead.slice(0, 60) + '…'
      : node.promptHead;
    label.appendChild(el('span', 'sat-head', ` · ${head}`));
  }

  row.appendChild(label);

  const meta = el('span', 'sat-meta');
  if (node.durationMs !== undefined) {
    meta.appendChild(el('span', 'sat-duration', formatDuration(node.durationMs)));
  }
  if (node.totalCostUsd !== undefined) {
    meta.appendChild(el('span', 'sat-cost', formatCost(node.totalCostUsd)));
  }
  if (meta.hasChildNodes()) row.appendChild(meta);

  return row;
}

/**
 * Recursively renders a node and its descendants into `container`.
 *
 * `collapsed` is a mutable set tracking which node IDs have been collapsed
 * by the user — it is shared across the full render and survives re-renders
 * because `renderSubagentTree` passes the same set reference each time.
 */
function renderNode(
  node: SubagentNode,
  container: HTMLElement,
  depth: number,
  isLast: boolean,
  collapsed: Set<string>,
  onToggle: (id: string) => void,
): void {
  const hasChildren = node.children.length > 0;
  const isCollapsed = collapsed.has(node.id);

  const wrapper = el('div', 'sat-node');
  wrapper.dataset['nodeId'] = node.id;

  const row = buildRow(node, depth, isLast);

  if (hasChildren) {
    row.classList.add('sat-row-expandable');
    const toggle = el('span', isCollapsed ? 'sat-toggle sat-collapsed' : 'sat-toggle');
    toggle.textContent = isCollapsed ? '▶' : '▼';
    toggle.setAttribute('aria-label', isCollapsed ? 'expand' : 'collapse');
    row.insertBefore(toggle, row.firstChild);

    row.addEventListener('click', () => {
      onToggle(node.id);
    });
  }

  wrapper.appendChild(row);

  if (hasChildren && !isCollapsed) {
    const childList = el('div', 'sat-children');
    node.children.forEach((child, i) => {
      renderNode(child, childList, depth + 1, i === node.children.length - 1, collapsed, onToggle);
    });
    wrapper.appendChild(childList);
  }

  container.appendChild(wrapper);
}

// ── Public render function ────────────────────────────────────────────────────

/**
 * Renders the full subagent tree into `container`, replacing its prior content.
 *
 * The `collapsed` Set is created on first call and stored on the container
 * element via a WeakMap so that collapse state persists across re-renders
 * triggered by new lifecycle events.
 */
const collapsedSets = new WeakMap<HTMLElement, Set<string>>();

export function renderSubagentTree(
  state: SubagentTreeState,
  container: HTMLElement,
): void {
  // Lazily create a collapsed-state set per container.
  let collapsed = collapsedSets.get(container);
  if (!collapsed) {
    collapsed = new Set<string>();
    collapsedSets.set(container, collapsed);
  }

  const roots = state.getRoots();

  // Guard: nothing to show.
  if (roots.length === 0) {
    container.textContent = '';
    return;
  }

  const onToggle = (id: string): void => {
    // collapsed is guaranteed defined here (captured in closure above).
    const set = collapsedSets.get(container)!;
    if (set.has(id)) {
      set.delete(id);
    } else {
      set.add(id);
    }
    // Re-render from state so structure stays consistent with new events that
    // may have arrived since the last render.
    renderSubagentTree(state, container);
  };

  container.textContent = '';
  const tree = el('div', 'sat-tree');

  roots.forEach((root, i) => {
    renderNode(root, tree, 0, i === roots.length - 1, collapsed!, onToggle);
  });

  container.appendChild(tree);
}
