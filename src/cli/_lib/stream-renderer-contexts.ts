/**
 * Context builders for StreamRenderer delegation paths.
 *
 * Extracted from stream-renderer.ts to decompose the class into focused modules.
 * These helpers construct the ctx objects passed to orchestrator and subagent
 * event handlers.
 *
 * @module cli/_lib/stream-renderer-contexts
 */

import type { OrchestratorCtx } from './stream-renderer-orchestrator.js';
import type { SubagentCtx } from './stream-renderer-subagent.js';
import type { ProgressEvent } from '../../agent/types.js';
import type { TerminalCompositor } from '../terminal-compositor.js';
import type { OverlayComposer } from './overlay-composer.js';
import type { ToolLane } from '../commands/interactive/tool-lane.js';
import type { ThinkingLane } from '../commands/interactive/thinking-lane.js';
import type { StreamingMarkdownRenderer } from '../markdown-stream.js';
import type { Writer } from '../slash/types.js';
import type { StageTrackerState } from '../commands/interactive/loop-stage.js';
import type { CommitCoordinator } from './commit-coordinator.js';
import type { SourceState } from './stream-renderer-source.js';
import { isDebugEnabled } from '../../utils/debug.js';

/**
 * Build the orchestrator ctx object for delegation to handleOrchestratorEvent.
 */
export function makeOrchestratorCtx(args: {
  out: Writer;
  isTTY: boolean;
  compositor: TerminalCompositor | null;
  overlayComposer: OverlayComposer | null;
  toolLane: ToolLane;
  thinkingLane: ThinkingLane;
  thinkingMode: 'off' | 'summary' | 'live';
  streamingMarkdown: { current: StreamingMarkdownRenderer | null };
  coordinator: CommitCoordinator;
  stageTracker?: StageTrackerState;
  activeSkillName?: string;
  lastProgressByTask: Map<string, ProgressEvent>;
}): OrchestratorCtx {
  return {
    out: args.out,
    isTTY: args.isTTY,
    compositor: args.compositor,
    overlayComposer: args.overlayComposer,
    toolLane: args.toolLane,
    thinkingLane: args.thinkingLane,
    thinkingMode: args.thinkingMode,
    streamingMarkdown: args.streamingMarkdown,
    coordinator: args.coordinator,
    lastProgressByTask: args.lastProgressByTask,
    // Hand the tracker only when we have a TTY compositor — non-TTY
    // surfaces (Telegram, daemon, tests) never call setComposedOverlay
    // anyway, and propagating a tracker through them would just be
    // noise on the type surface.
    ...(args.isTTY && args.stageTracker ? { stageTracker: args.stageTracker } : {}),
    ...(args.activeSkillName ? { activeSkillName: args.activeSkillName } : {}),
  };
}

/**
 * Build the subagent ctx object for delegation to handleSubagentEvent.
 */
export function makeSubagentCtx(args: {
  isTTY: boolean;
  compositor: TerminalCompositor | null;
  toolLane: ToolLane;
  out: Writer;
  streamingMarkdown: Map<string, StreamingMarkdownRenderer>;
  thinkingMode: 'off' | 'summary' | 'live';
  orchestratorCtx: OrchestratorCtx;
}): SubagentCtx {
  return {
    isTTY: args.isTTY,
    compositor: args.compositor,
    toolLane: args.toolLane,
    out: args.out,
    streamingMarkdown: args.streamingMarkdown,
    // Cascade the orchestrator's thinking mode to subagents so the
    // (`off` | `summary` | `live`) knob the user sets via `--thinking`
    // governs both surfaces. One knob, one mental model. See
    // SubagentCtx.thinkingMode for the per-mode behavior contract.
    thinkingMode: args.thinkingMode,
    // Invariant (issue #389): every subagent event handler routes its overlay
    // repaint through `setComposedOverlay(ctx.orchestratorCtx)`. That call is
    // guarded by `ctx.orchestratorCtx`, so production MUST thread the live
    // orchestrator ctx here — otherwise the guard is permanently false and no
    // subagent repaint ever reaches the compositor. Required (not optional) so
    // `tsc` fails loudly if a future caller forgets it. The ctx shares the
    // renderer's toolLane / thinkingLane / lastProgressByTask, so the composed
    // frame includes the orchestrator's thinking paragraph + progress banner.
    orchestratorCtx: args.orchestratorCtx,
  };
}

/**
 * Resolve the parent synthetic ID for a new subagent source.
 * Used during the first event from a subagent to determine where the
 * synthesized `Agent(...)` entry should nest.
 *
 * Resolve nesting in priority order when `meta.parentId` is present:
 *   1. subagent-source — parentId is a known subagent source; use that
 *      source's synthetic Agent tool-use id (grandchild nesting).
 *   2. toolLane-entry — parentId is a registered `tool` entry; use parentId
 *      directly so the Agent nests under the dispatching tool's lane entry.
 *   3. unresolved — parentId is neither; leave undefined so the Agent entry
 *      renders at root.
 */
export function resolveParentSyntheticId(args: {
  parentId: string | undefined;
  sources: Map<string, SourceState>;
  toolLane: ToolLane;
  sourceId: string;
}): string | undefined {
  if (args.parentId === undefined) {
    return undefined;
  }
  const parentSource = args.sources.get(args.parentId);
  if (parentSource !== undefined) {
    // Path 1: grandchild — parentId is a subagent source.
    return parentSource.syntheticAgentToolUseId;
  }
  if (args.toolLane.hasEntry(args.parentId)) {
    // Path 2: compose-spawned — parentId is a live tool-lane entry.
    return args.parentId;
  }
  // Path 3: unresolved — leave undefined, trace for observability.
  // Most commonly this fires when parentId is the parent's Anthropic
  // session UUID (regular subagent path); the Agent entry then
  // renders at root, which is the correct legacy behavior.
  if (isDebugEnabled()) {
    process.stderr.write(
      `[stream-renderer] parentId_fallback_unresolved ${JSON.stringify({ parentId: args.parentId, sourceId: args.sourceId })}\n`,
    );
  }
  return undefined;
}
