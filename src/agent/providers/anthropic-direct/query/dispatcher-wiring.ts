/**
 * Dispatcher + awareness-source wiring for one `AnthropicDirectProvider.query()`
 * call, plus the presence registration that sits between them.
 *
 * Extracted from `index.ts` (#824). The three steps below were previously
 * spread across ~80 lines of a 425-line method; they are gathered here
 * DELIBERATELY so the ordering constraint is local, visible, and impossible to
 * split by an edit elsewhere in the file.
 *
 * Invariant: `queryDispatcher` is declared, captured, and assigned in that
 * exact order, and the order is load-bearing.
 *
 *   1. DECLARE `let queryDispatcher` with no initializer.
 *   2. BUILD `runtimeStateSource`, whose `getEnabledToolNames` closure captures
 *      the *binding* and reads it lazily, at tool-dispatch time.
 *   3. ASSIGN `queryDispatcher` — passing that same `runtimeStateSource` INTO
 *      `buildDispatcher`, which registers the `get_runtime_state` handler over
 *      it.
 *
 * Steps 2 and 3 form a genuine cycle: the source must exist before the
 * dispatcher (the dispatcher registers a handler over it), and the dispatcher
 * must exist before the source is *called* (the closure reads it). Deferring
 * the read to call time is the only thing that makes the cycle resolvable.
 *
 * Consequence of getting it wrong: if the closure is ever changed to read the
 * tool list EAGERLY, or if a refactor builds a second source after the
 * dispatcher and hands the dispatcher the stale first one, then
 * `get_runtime_state` reports a stale or empty tool list. There is no throw,
 * no type error, and no other failing assertion — the model is simply told the
 * wrong thing about itself. `query-wiring.characterization.test.ts` is the
 * tripwire: it drives a real `get_runtime_state` call through the real
 * dispatcher and asserts the reported list contains a custom tool that exists
 * only on the instance built in step 3.
 *
 * `registerPresenceLifecycle` is called between steps 2 and 3 because it needs
 * the source (for `getWorkspace()`) but not the dispatcher. It reads no tool
 * state, so its position is safe — but it must stay AFTER the source is built.
 *
 * @module agent/providers/anthropic-direct/query/dispatcher-wiring
 */

import type { AgentConfig } from '../../../types/config-types.js';
import type { AnthropicToolDef } from '../../../tools/types.js';
import type { ToolDispatcher } from '../tool-dispatcher.js';
import { SessionToolDispatcher } from '../../../tools/dispatcher.js';
import {
  buildRuntimeStateSource,
  getRuntimeStateTool,
  wrapDispatcherWithRuntimeState,
  type RuntimeSourceDeps,
  type RuntimeStateSource,
} from '../../../awareness/index.js';
import { builtinToolSchemas } from '../../../tools/schemas.js';
import { registerPresenceLifecycle, resolveTopLevelSessionId } from './presence-lifecycle.js';
import type { BuildDispatcherOptions } from '../build-dispatcher.js';
import type { RuntimeSubagents } from '../../../awareness/index.js';

export interface DispatcherWiringArgs {
  config: AgentConfig;
  /** Resolved wire model id (post `resolveModelId`). */
  model: string;
  permissionMode: string;
  surface: string;
  providerName: string;
  /** Non-null only when the caller injected an external dispatcher. */
  externalTools: ToolDispatcher | undefined;
  sharedReadRoots: string[] | undefined;
  sharedWriteRoots: string[] | undefined;
  /**
   * Live cwd accessor for the awareness source. Must reflect mid-session
   * `setCwd()` re-anchors, not the construction-time `config.cwd` — see
   * {@link RuntimeSourceDeps.getCwd}.
   */
  getCwd: () => string;
  /** Live MCP tool accessor for the awareness source. */
  getMcpTools: () => readonly AnthropicToolDef[];
  /** Live subagent accessor for the awareness source. */
  getSubagents: () => RuntimeSubagents;
  /** Provider-owned memoized top-level session id. */
  getMintedSessionId: () => string | null;
  setMintedSessionId: (value: string | null) => void;
  /** Provider-owned presence registration marker. */
  getPresenceSessionId: () => string | null;
  setPresenceSessionId: (value: string | null) => void;
  buildDispatcher: (
    permissionMode: string,
    opts: BuildDispatcherOptions,
  ) => SessionToolDispatcher;
}

export interface DispatcherWiring {
  queryDispatcher: ToolDispatcher;
  runtimeStateSource: RuntimeStateSource;
  /** Tool defs to advertise, after the skill-dispatch / non-interactive filters. */
  toolDefs: AnthropicToolDef[];
  /** The session id the presence file advertises and the query must reuse. */
  resolvedSessionId: string | undefined;
}

/**
 * Build the per-query dispatcher, the awareness source it serves, and the
 * advertised tool-def list — preserving the late-binding order documented in
 * this module's header.
 */
export function wireQueryDispatcher(args: DispatcherWiringArgs): DispatcherWiring {
  const { config, surface } = args;

  // STEP 1 — declare. Awareness layer source: declared as a `let` because the
  // dispatcher and the source have a benign cycle; `getEnabledToolNames`
  // resolves through a closure that reads `queryDispatcher` lazily at
  // handler-call time, so the assignment-before-use ordering below is safe.
  let queryDispatcher: ToolDispatcher;

  // STEP 2 — build the source, capturing the binding above.
  const runtimeStateSource: RuntimeStateSource = buildRuntimeStateSource({
    surface,
    getCwd: args.getCwd,
    modelName: args.model,
    providerName: args.providerName,
    permissionMode: args.permissionMode,
    ...(config.sessionId !== undefined ? { sessionId: config.sessionId } : {}),
    ...(config.parentSessionId !== undefined
      ? { parentSessionId: config.parentSessionId }
      : {}),
    ...(config.depth !== undefined ? { depth: config.depth } : {}),
    ...(config.maxDepth !== undefined ? { maxDepth: config.maxDepth } : {}),
    ...(config.phaseRole !== undefined ? { phaseRole: config.phaseRole } : {}),
    // LAZY BY CONTRACT: reads `queryDispatcher` at call time, which is always
    // after STEP 3 has run. Must never be changed to snapshot eagerly.
    getEnabledToolNames: () =>
      queryDispatcher instanceof SessionToolDispatcher
        ? queryDispatcher.toolDefs.map((t) => t.name)
        : [],
    getMcpTools: args.getMcpTools,
    getSubagents: args.getSubagents,
  });

  // Invariant: presence and query construction MUST use the same session id,
  // because the Telegram watcher resolves a session's ledger path from the id
  // in its presence file. Resolve once here — BEFORE the presence write — and
  // reuse the result for `new AnthropicDirectQuery`, so the presence file, the
  // `session.init` event, and the ledger directory cannot diverge. Reading
  // `config.sessionId` alone is what broke this: it is set only under
  // --resume, so fresh sessions advertised nothing at all.
  const resolvedSession = resolveTopLevelSessionId({
    sessionId: config.sessionId,
    resume: config.resume,
    depth: config.depth,
    parentSessionId: config.parentSessionId,
    surface,
    memoized: args.getMintedSessionId(),
  });
  args.setMintedSessionId(resolvedSession.memoized);

  args.setPresenceSessionId(
    registerPresenceLifecycle({
      depth: config.depth,
      parentSessionId: config.parentSessionId,
      sessionId: resolvedSession.id,
      currentPresenceSessionId: args.getPresenceSessionId(),
      runtimeStateSource,
      surface,
      cwd: config.cwd,
      providerName: args.providerName,
      model: args.model,
    }),
  );

  // STEP 3 — assign. The source built in STEP 2 is handed to the dispatcher so
  // the `get_runtime_state` handler resolves against it.
  queryDispatcher = args.externalTools
    ? wrapDispatcherWithRuntimeState(args.externalTools, runtimeStateSource)
    : args.buildDispatcher(args.permissionMode, {
        cwd: config.cwd,
        readRoots: args.sharedReadRoots,
        writeRoots: args.sharedWriteRoots,
        ...(config.env !== undefined ? { env: config.env } : {}),
        sessionId: config.sessionId,
        parentSessionId: config.parentSessionId,
        ...(config.subagentId !== undefined ? { subagentId: config.subagentId } : {}),
        // Fork-scoped central output cap (#661): forwarded from the child
        // config that forkSubagent stamped, arming maxOutputBytes for forks
        // only (top-level leaves it unset).
        ...(config.subagentToolOutputCapBytes !== undefined
          ? { subagentToolOutputCapBytes: config.subagentToolOutputCapBytes }
          : {}),
        traceWriter: config.traceWriter,
        runtimeStateSource,
        hookRegistry: config.hookRegistry,
        planExitControls: config.planExitControls,
      });

  // External-dispatcher branch: the caller owns routing for whatever tools
  // it cares about, but we still offer `get_runtime_state` because the
  // wrapper above intercepts it before it ever reaches the inner dispatcher.
  // Without adding the schema here the model has no way to know the tool
  // exists — leaving the awareness layer reachable only via the
  // `SessionToolDispatcher` path.
  const baseToolDefs = queryDispatcher instanceof SessionToolDispatcher
    ? [...queryDispatcher.toolDefs]
    : [...builtinToolSchemas, getRuntimeStateTool];
  // Invariant: skill-dispatch sub-agents are dispatched AS a specific skill, so
  // they must neither (a) pause to ask the operator "which skill?" nor (b) mutate
  // the operator's environment. Strip `ask_question` (the operator-prompt escape
  // hatch) and `terminal_font_size` (an environment tool with no role in skill
  // work — a bare numeric skill arg such as a PR number can otherwise lure a
  // confused model into calling terminal_font_size(<n>) instead of running the
  // skill). Gated on isSkillDispatch; pairs with the SLASH_COMMAND_ROUTING_PROMPT
  // omission in the system-prompt assembly. Verified safe: no bundled/registry/
  // user skill calls either tool.
  // Non-interactive surfaces (daemon, scheduler/cron, one-shot `afk chat`)
  // install no elicitation handler, so `ask_question` can only auto-decline
  // (elicitation-router.ts). Strip it so the model proceeds on an assumption
  // or emits Blocked rather than burning a turn on an unanswerable prompt.
  // Narrower than the skill-dispatch strip: `terminal_font_size` is retained.
  const toolDefs = config.isSkillDispatch
    ? baseToolDefs.filter(
        (t) =>
          t.name !== 'ask_question' &&
          t.name !== 'terminal_font_size' &&
          t.name !== 'clipboard_write',
      )
    : config.isNonInteractive
      ? baseToolDefs.filter(
          (t) => t.name !== 'ask_question' && t.name !== 'clipboard_read',
        )
      : baseToolDefs;

  return {
    queryDispatcher,
    runtimeStateSource,
    toolDefs,
    resolvedSessionId: resolvedSession.id,
  };
}
