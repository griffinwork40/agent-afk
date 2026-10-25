import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { SubagentDAGNode, SubagentDAGOptions } from './dag-subagent.js';
import type { SubagentResult } from './subagent/result.js';
import type { SpawnReceipt } from './tools/delegation-budget.js';
import { appendImageBlocks } from './content/image-blocks.js';
import { setupIsolationWorktree } from './tools/subagent-executor.execute-once.helpers.js';
import { teardownBackgroundWorktree } from './tools/handlers/worktree-managed.background.js';
import { debugLog } from '../utils/debug.js';
import { isTooBroadRoot, ungatedSensitiveRoot } from './tools/subagent/root-validation.js';
import { realpathSafe } from './tools/handlers/_cwd-utils.js';
import { resolveChildModel } from './subagent/resolve-child-model.js';

/**
 * Invariant: validate that a DAG node's `cwd`, `readRoots`, and `writeRoots` pass the
 * same grant-breadth guards that `parseAgentInput` enforces on the agent-tool
 * path. Without this, `runSubagentDAG` is a second, unguarded doorway into
 * `forkSubagent` — any root that would drop credential candidates from the
 * bash restriction hook bypasses the guard entirely (#982).
 *
 * Farm's pinned roots (worktree subdirectories) pass both guards — they are
 * deep project-specific paths, not home / filesystem root / AFK dirs.
 *
 * // Invariant: the `field` strings in `candidates` are the USER-FACING names
 * // `cwd`, `readRoots`, `writeRoots`, and `extraReadRoots` — matching the
 * // {@link SubagentDAGNode} interface, not any internal alias. Error messages
 * // interpolate `field` directly, so users always see the name they set on
 * // the node spec.
 */
function validateDagNodeRoots(spec: SubagentDAGNode): void {
  const candidates: Array<{ value: string; field: string }> = [];
  if (spec.cwd !== undefined) candidates.push({ value: spec.cwd, field: 'cwd' });
  for (const r of spec.pinnedReadRoots ?? []) candidates.push({ value: r, field: 'pinnedReadRoots' });
  for (const r of spec.writeRoots ?? []) candidates.push({ value: r, field: 'writeRoots' });
  // Internal field is `extraReadRoots` but the user-facing compose schema calls it `readRoots`.
  // Use the user-facing name in error messages so the model can map errors to its input.
  for (const r of spec.extraReadRoots ?? []) candidates.push({ value: r, field: 'readRoots (extraReadRoots)' });

  for (const { value, field } of candidates) {
    // Resolve symlinks before checking — mirrors input-parse.ts's dual-check
    // pattern. A symlink to $HOME or / passes the lexical check yet grants a
    // broad real root at fork time (#982 symlink sub-vector).
    const real = realpathSafe(value);
    if (isTooBroadRoot(value) || isTooBroadRoot(real)) {
      throw new Error(
        `DAG node "${spec.id}" ${field} "${value}" is too broad ` +
          '(filesystem root, home directory, or AFK directory)',
      );
    }
    const sensitive = ungatedSensitiveRoot(value) ?? ungatedSensitiveRoot(real);
    if (sensitive !== undefined) {
      throw new Error(
        `DAG node "${spec.id}" ${field} "${value}" would un-gate ` +
          `credential root "${sensitive}"`,
      );
    }
  }
}


/** Contract: adapt shared setup to DAG's lazy prompts and already-assigned counter. */
async function setupDagIsolation(
  spec: SubagentDAGNode, anchorCwd: string | undefined, nodeSignal: AbortSignal,
  isolationCounter: number, budgetReceipt: SpawnReceipt | undefined,
) {
  const childConfig: { cwd?: string } = {};
  const iso = await setupIsolationWorktree({
    parsed: { prompt: '', mode: 'foreground', id_prefix: `compose-${spec.id}` },
    currentCwd: anchorCwd, isolationCounterRef: { value: isolationCounter - 1 },
    childConfig, childWriteCapable: true, probe: undefined,
    budgetReceipt, signal: nodeSignal, dagNodeId: spec.id,
  });
  const build = spec.promptBuilder;
  const notice = iso.setupNotice;
  return {
    ...iso,
    spec: {
      ...spec, cwd: childConfig.cwd,
      ...(notice !== undefined ? { promptBuilder: (i: Record<string, unknown>) => `${notice}\n\n${build(i)}` } : {}),
    },
  };
}

export async function dispatchDagNode(
  originalSpec: SubagentDAGNode, inputs: Record<string, unknown>, nodeSignal: AbortSignal,
  options: SubagentDAGOptions, softDeadlineForNode: number, isolationCounter: number,
): Promise<SubagentResult> {
  const { manager, parentSession, delegationBudget, anchorCwd } = options;
  if (nodeSignal.aborted) throw new DOMException('Aborted', 'AbortError');
  // Mutable copy so isolation can override spec.cwd with the worktree path.
  let spec = originalSpec;
  // Invariant (#982): validate roots BEFORE forkSubagent — this is the
  // only guard on the DAG path. parseAgentInput guards the agent-tool path;
  // this guards the library-API path. Without it, a caller that derives a
  // root from model output bypasses both isTooBroadRoot and
  // ungatedSensitiveRoot.
  validateDagNodeRoots(spec);

  // Item 2: per-node delegation budget check + charge. The single canSpawn
  // call in compose-executor was never followed by recordSpawn, so a 20-node
  // DAG counted as zero spawns. Checking here ensures every forked node is
  // counted and released. parentId is the parent session's sessionId so the
  // per-agent child count tracks against the root (compose nodes share one
  // parent session, mirroring the agent-tool path).
  let dagNodeBudgetReceipt: SpawnReceipt | undefined;
  if (delegationBudget) {
    const budgetCheck = delegationBudget.canSpawn(parentSession.sessionId ?? '');
    if (!budgetCheck.allowed) {
      throw new Error(
        `DAG node "${spec.id}" blocked by delegation budget: ${budgetCheck.detail ?? budgetCheck.reason ?? 'budget exceeded'}`,
      );
    }
    dagNodeBudgetReceipt = delegationBudget.recordSpawn(parentSession.sessionId ?? '');
  }

  // Invariant: DAG isolation always creates a foreground worktree, including
  // read-only nodes. Retain node-specific slugs/errors and caller-owned teardown.
  let isolationTeardown: { repoRoot: string; worktreePath: string } | undefined;
  let setupNotice: string | undefined;
  if (spec.isolation === 'worktree') {
    const iso = await setupDagIsolation(spec, anchorCwd, nodeSignal, isolationCounter, dagNodeBudgetReceipt);
    isolationTeardown = iso.teardown;
    setupNotice = iso.setupNotice;
    spec = iso.spec;
  }

  // Stage 3 (#4042): resolve the node model through the shared four-tier chain
  // (callSite → namedAgent → defaultSubagentModel → defaultModel → 'sonnet')
  // instead of the inline `spec.model ?? 'sonnet'` that skipped tiers 3 and 4.
  // Compose pre-resolves spec.model via resolveChildModel before building the
  // DAG node, so callSiteModel here is always set for compose nodes. Direct
  // library callers (skills, mint phases) that omit spec.model now honour
  // options.defaultSubagentModel and options.defaultModel instead of silently
  // falling to 'sonnet'.
  const resolvedNodeModel = resolveChildModel({
    callSiteModel: typeof spec.model === 'string' ? spec.model : undefined,
    defaultSubagentModel: typeof options.defaultSubagentModel === 'string' ? options.defaultSubagentModel : undefined,
    defaultModel: typeof options.defaultModel === 'string' ? options.defaultModel : undefined,
  });

  let handle: Awaited<ReturnType<typeof manager.forkSubagent>>;
  try {
    handle = await manager.forkSubagent({
      parent: { sessionId: parentSession.sessionId, messageJournal: parentSession.messageJournal },
      config: {
        model: resolvedNodeModel,
        systemPrompt: spec.systemPrompt,
        ...(spec.canUseTool !== undefined ? { canUseTool: spec.canUseTool } : {}),
        ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
        ...(spec.pinnedReadRoots !== undefined ? { readRoots: spec.pinnedReadRoots } : {}),
        ...(spec.extraReadRoots !== undefined ? { extraReadRoots: spec.extraReadRoots } : {}),
        ...(spec.writeRoots !== undefined ? { writeRoots: spec.writeRoots } : {}),
        ...(spec.apiKey !== undefined ? { apiKey: spec.apiKey } : {}),
        ...(spec.maxToolUseIterations !== undefined
          ? { maxToolUseIterations: spec.maxToolUseIterations }
          : {}),
        ...(spec.maxTurns !== undefined ? { maxTurns: spec.maxTurns } : {}),
        // Workspace provider: when present, the compose executor has built a
        // workspace-aware provider via buildComposeNodeProvider so that this
        // node can call workspace_publish / workspace_query. Without it the
        // node's AgentSession falls back to bare resolveProvider which never
        // carries workspaceStore, silently stripping both tools from the schema.
        ...(spec.provider !== undefined ? { provider: spec.provider } : {}),
        // Invariant: a DAG node has a SECOND wall-clock enforcer that does not
        // route through `agent/timeout.ts` — runDAG arms its own per-node
        // `setTimeout` (dag.ts) and cascades expiry into `handle.cancel()`
        // below. That path has the identical gap the fork budget had: it kills
        // a slow-but-working child with everything it learned unsynthesized.
        // Arm the soft deadline from the node budget so the node winds down at
        // a round boundary first. `resolveSoftDeadlineMs` returns 0 (off) for
        // an absent or too-short node budget, so unbounded nodes and short ones
        // keep prior behaviour exactly; when it is off here, `forkSubagent`
        // still derives one from the fork's own timeout. Whichever budget is
        // SMALLER binds, so take the min: deriving from the node timeout alone
        // would arm a deadline later than the fork budget that will actually
        // fire.
        ...(softDeadlineForNode !== 0 ? { softDeadlineMs: softDeadlineForNode } : {}), depth: spec.depth, maxDepth: spec.maxDepth,
      },
      idPrefix: spec.idPrefix ?? `dag-${spec.id}`,
      ...(spec.outputSchema !== undefined ? { outputSchema: spec.outputSchema } : {}),
      // Render hints: lift label + parent anchor through to the CLI so the
      // tool-lane can render `Agent(<label>)` entries nested under the
      // dispatching tool's entry (e.g. `compose`). agentType is required
      // on ForkSubagentOptions — fall back to idPrefix when the caller did
      // not supply an explicit display label.
      agentType: spec.agentType ?? spec.idPrefix ?? `dag-${spec.id}`,
      ...(spec.parentId !== undefined ? { parentId: spec.parentId } : {}),
      ...(spec.modelFallback !== undefined ? { modelFallback: spec.modelFallback } : {}),
    });
  } catch (forkErr) {
    // Item 2: rollback ALL budget counters on fork failure — the child
    // never ran, so total and concurrentChildrenByAgent must not reflect this spawn.
    dagNodeBudgetReceipt?.rollback();
    dagNodeBudgetReceipt = undefined;
    // Tear down any isolated worktree that was created but never used.
    if (isolationTeardown) {
      await teardownBackgroundWorktree(isolationTeardown).catch((teardownErr) => {
        debugLog(`[dag-subagent] teardown failed for worktree ${isolationTeardown?.worktreePath ?? '?'} (fork error path):`, teardownErr);
      });
    }
    throw forkErr;
  }

  // Forward DAG-level node abort (e.g. nodeTimeoutMs, fail-fast cascade,
  // parent compose-call abort) into the subagent handle. Without this,
  // nodeController.abort() reaches no consumer — the handle's controller
  // is independent — and the subagent keeps streaming until natural
  // completion. Wiring this is what makes DAG-level supervision REAL
  // rather than fake.
  const onNodeAbort = (): void => {
    void handle.cancel().catch(() => undefined);
  };
  if (nodeSignal.aborted) {
    void handle.cancel().catch(() => undefined);
  } else {
    nodeSignal.addEventListener('abort', onNodeAbort, { once: true });
  }

  try {
    if (nodeSignal.aborted) throw new DOMException('Aborted', 'AbortError');
    // When resolvedAttachments is set, build a multimodal ContentBlockParam[]
    // array: a text block carrying the string prompt followed by image blocks.
    // This is the compose-executor path for per-node attachments declared in
    // the compose input.
    let prompt: string | ContentBlockParam[];
    if (spec.resolvedAttachments !== undefined && spec.resolvedAttachments.length > 0) {
      const blocks: ContentBlockParam[] = [{ type: 'text', text: spec.promptBuilder(inputs) }];
      appendImageBlocks(blocks, spec.resolvedAttachments);
      prompt = blocks;
    } else {
      prompt = spec.promptBuilder(inputs);
    }
    const result = await handle.runToResult(prompt);
    // V1 safety net: compose/DAG nodes cannot yield — a yielding node looks
    // like a successful completion to the DAG executor, so downstream nodes
    // would proceed on partial data. Fail-fast so the error is surfaced
    // immediately rather than silently propagating a bad result.
    if (result.needsInput !== undefined) {
      throw new Error(
        `DAG node ${handle.id} yielded Asking — compose nodes cannot yield in v1. ` +
        `Question: ${result.needsInput.question}`,
      );
    }
    // #3601 / #3660: attach setupNotice as a dedicated field on the result so
    // the DAG layer (dag-subagent.ts) can propagate it through DAGRunResult
    // regardless of return path. The notice is already injected into the node's
    // prompt via setupDagIsolation's wrapped promptBuilder; duplicating it into
    // message.content caused a double-prepend on nodes that also produce
    // plain-string content, so we attach it as a dedicated field instead.
    return setupNotice !== undefined ? { ...result, setupNotice } : result;
  } finally {
    nodeSignal.removeEventListener('abort', onNodeAbort);
    await handle.teardown().catch(() => undefined);
    // Item 2: release the concurrent slot now that the node has settled.
    // The fork succeeded, so use release() — total and concurrentChildrenByAgent
    // correctly reflect a real spawn even if the run aborted mid-flight.
    dagNodeBudgetReceipt?.release();
    // Tear down the isolated worktree when the node finishes. Dirty /
    // commits-ahead trees are preserved and locked by teardownBackgroundWorktree
    // so work is never silently discarded. Mirrors the foreground teardown
    // path in subagent-executor.ts (the DAG path is always foreground).
    if (isolationTeardown) {
      await teardownBackgroundWorktree(isolationTeardown).catch((teardownErr) => {
        debugLog(`[dag-subagent] teardown failed for worktree ${isolationTeardown?.worktreePath ?? '?'} (finally path):`, teardownErr);
      });
    }
  }
}
