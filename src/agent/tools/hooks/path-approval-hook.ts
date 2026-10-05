/**
 * Path-approval hooks: PreToolUse + PostToolUse.
 *
 * Intercepts typed file-tool calls (`read_file`, `write_file`, `edit_file`,
 * `list_directory`, `glob`, `grep`) targeting paths outside the session's
 * granted roots and elicits user approval before allowing them through.
 *
 * # Invariant — threat model
 *
 * This hook prevents ACCIDENTAL access to sensitive paths by a non-adversarial
 * model. It is NOT a security boundary against an actively adversarial
 * model. The hook only inspects typed file tools; bash invocations are gated
 * separately by `bash-restriction-hook.ts` (with much narrower scope, since
 * bash is Turing-complete and any string-based filter has known bypasses:
 * interpreter scripts, variable assembly, /proc/self/fd, brace expansion,
 * process substitution). For adversarial containment, run agent-afk inside
 * an OS-level sandbox: macOS `sandbox-exec` or Linux Landlock/seccomp.
 *
 * # Flow
 *
 * On a `PreToolUse` event whose tool is one of the typed file tools AND whose
 * resolved path falls outside every granted root:
 *
 *   0. If the call originates inside a forked sub-agent (`parentSessionId`
 *      set), block immediately — sub-agents never prompt the operator; they
 *      report the out-of-root path requirement back to their parent, which
 *      owns the surface and can grant access.
 *   1. Check the in-process "always for this session" allow-cache — if the
 *      path is in there, fall through without prompting.
 *   2. Otherwise, deduplicate against any in-flight request for the same
 *      `(tool, path)` pair — concurrent prompts collapse to one.
 *   3. Call `elicitationRouter.route()` with a 4-option form:
 *        [once] [session] [persist] [deny]
 *   4. Map the response:
 *        once     → grantManager.addReadRoot + record in `onceApprovedPaths`
 *                   (the paired PostToolUse hook revokes after the call).
 *        session  → grantManager.addReadRoot/addWriteRoot (in-memory only)
 *        persist  → grantManager.addReadRoot + appendGrant() to disk
 *        deny     → return { decision: 'block', reason: ... }
 *   5. On no installed handler / decline / cancel: block.
 *
 * # Wiring
 *
 * The PreToolUse handler is registered with `longRunning: true` so the 30s
 * per-handler timeout in the dispatch loop is bypassed. The elicitation router
 * has NO time-based deadline — an AFK operator may take minutes or hours to
 * answer — so the ONLY unblock-on-teardown path is the turn/dispatch abort
 * signal, which the hook forwards into `elicitationRouter.route()` so session/
 * turn teardown cancels a pending prompt. On a surface with no installed
 * elicitation handler the route resolves immediately as a decline. The
 * PostToolUse handler is synchronous (only revokes a root from an in-process
 * set) and runs under the default timeout.
 *
 * @module agent/tools/hooks/path-approval-hook
 */

import path from 'path';
import type { GrantManager } from '../grant-manager.js';
import { wouldBeRestricted } from '../handlers/_cwd-utils.js';
import {
  isReadDenied,
  READ_DENYLIST_ENTRY_MARKER,
  PROTECTED_CREDENTIAL_PATH_MARKER,
} from '../handlers/read-denylist.js';
import { buildForkPathDenialReason } from './fork-denial-remedy.js';
import type { HookContext, HookDecision, HookHandler } from '../../hooks.js';
import {
  extractCandidatePath,
  extractAllPaths,
  promptForApproval,
} from './path-approval-hook.prompt.js';
export { extractCandidatePath, extractAllPaths } from './path-approval-hook.prompt.js';
import { isSubagentContext } from '../../hooks/hook-utils.js';

/** Tools subject to per-call path approval. Bash is gated separately. */
const TYPED_FILE_TOOLS = new Set([
  'read_file',
  'view_image',
  'write_file',
  'edit_file',
  'list_directory',
  'glob',
  'grep',
  'patch_apply',
  'json_query',
]);

/** Tools that write — used to pick read-vs-write containment + grant mode. */
const WRITE_TOOLS = new Set(['write_file', 'edit_file', 'patch_apply']);

/** Surface label threaded into the persisted grant for audit. */
export type PathApprovalSurface = 'repl' | 'telegram' | 'web' | 'unknown';

export interface PathApprovalHookOptions {
  /**
   * Returns the current cwd / resolveBase used by the dispatcher. Required to
   * mirror the handler's `resolveAndContain` semantics; without it, the hook
   * cannot reproduce the same containment verdict the handler will reach.
   */
  getCwd: () => string | undefined;
  /**
   * Surface label baked into persisted grants so the audit trail shows
   * provenance (`elicit:repl` vs. `elicit:telegram`). Static per session.
   */
  surface: PathApprovalSurface;
}

/** Shared closure state between the Pre/Post hooks. */
export interface PathApprovalState {
  /** Set of `<mode>:<resolvedPath>` keys approved for the whole session. */
  sessionApproved: Set<string>;
  /**
   * Map of `<mode>:<resolvedPath>` → grant metadata for paths approved
   * "Once". On PostToolUse, the corresponding root is revoked from the
   * grant manager and the key removed.
   *
   * `capturedCwd` is the cwd sampled at PreToolUse time and used verbatim
   * when PostToolUse reconstructs the revoke key. Storing it here prevents
   * a cwd change between Pre and Post (e.g. /cwd slash command, worktree
   * rename) from causing the revoke to miss the entry and leak the grant.
   */
  onceApproved: Map<string, { resolvedPath: string; mode: 'read' | 'write'; capturedCwd: string | undefined }>;
  /** In-flight elicitations — dedupes concurrent prompts for the same path. */
  inFlight: Map<string, Promise<HookDecision>>;
  /**
   * The grant manager resolved during the most recent PreToolUse invocation.
   * Stored so the SessionEnd safety-net can revoke outstanding "Once" grants
   * without needing a process-global ref: SessionEnd context carries no
   * `grantManager` field (it is not a tool call), so we cache it here once
   * the per-session dispatcher injects it via `context.grantManager`.
   */
  lastSeenGrantManager: GrantManager | undefined;
}

export interface PathApprovalHookHandlers {
  /** Register at PreToolUse with `{ longRunning: true }`. */
  preToolUse: HookHandler;
  /** Register at PostToolUse (default options). */
  postToolUse: HookHandler;
  /**
   * Register at SessionEnd. Revokes any "Once" grants still outstanding —
   * the safety net for the case where PostToolUse never ran (e.g. the tool
   * call's signal aborted, so `dispatchPostToolUse` short-circuited before
   * the revoke). Without this, an aborted-mid-call "Once" grant would leak
   * into a full-session grant.
   */
  sessionEnd: HookHandler;
}

function pathApprovalKey(mode: 'read' | 'write', resolvedPath: string): string {
  return `${mode}:${resolvedPath}`;
}

/**
 * Factory. Returns a `{ preToolUse, postToolUse, sessionEnd }` triple closing
 * over shared cache + in-flight state. Register `preToolUse` with
 * `{ longRunning: true }` so the dispatcher does not race the elicitation
 * prompt against its 30s per-handler timeout. `postToolUse` and `sessionEnd`
 * use default options.
 */
export function createPathApprovalHook(
  opts: PathApprovalHookOptions,
): PathApprovalHookHandlers {
  const state: PathApprovalState = {
    sessionApproved: new Set<string>(),
    onceApproved: new Map<string, { resolvedPath: string; mode: 'read' | 'write'; capturedCwd: string | undefined }>(),
    inFlight: new Map<string, Promise<HookDecision>>(),
    lastSeenGrantManager: undefined,
  };

  // Forward the turn/dispatch `signal` (second handler arg) into the impl so a
  // pending elicitation prompt is cancelled on session/turn teardown.
  const preToolUse: HookHandler = async (context, signal) =>
    preToolUseImpl(opts, state, context, signal);
  const postToolUse: HookHandler = (context) => postToolUseImpl(opts, state, context);
  const sessionEnd: HookHandler = (context) => sessionEndImpl(opts, state, context);

  return { preToolUse, postToolUse, sessionEnd };
}

async function preToolUseImpl(
  opts: PathApprovalHookOptions,
  state: PathApprovalState,
  context: HookContext,
  signal?: AbortSignal,
): Promise<HookDecision> {
  if (context.event !== 'PreToolUse') return {};
  if (!TYPED_FILE_TOOLS.has(context.toolName)) return {};

  const input = context.input as Record<string, unknown> | undefined;
  if (!input) return {};
  const candidate = extractCandidatePath(context.toolName, input);
  if (candidate === undefined) return {};

  const mode: 'read' | 'write' = WRITE_TOOLS.has(context.toolName)
    ? 'write'
    : 'read';

  // Reproduce the handler's containment check. cwd / readRoots / writeRoots
  // are sampled from the grant manager using the same fresh-snapshot pattern
  // the dispatcher uses on every handler call.
  //
  // The per-session dispatcher injects `context.grantManager` on every
  // PreToolUse / PostToolUse call (#527). Cache the resolved manager in state
  // so the SessionEnd safety-net can reach it without a process-global ref.
  const grantManager = context.grantManager;
  if (!grantManager) {
    // Failsafe — no wired grant manager (headless, one-shot, daemon, or a
    // test dispatcher constructed without a provider). Skip the approval
    // pre-check and let the handler's own resolveAndContain enforce
    // containment as it does today. Documented in module header.
    return {};
  }
  // Cache for SessionEnd (which carries no grantManager on its context).
  state.lastSeenGrantManager = grantManager;
  const grants = grantManager.getGrants();
  // Invariant: capture cwd ONCE here and thread it into the onceApproved
  // entry. postToolUseImpl reuses this stored value (not a fresh getCwd())
  // so a cwd change between Pre and Post (worktree rename, /cwd command)
  // cannot cause the revoke to miss the correct key.
  const cwd = opts.getCwd();

  // Resolve the candidate to an absolute path the SAME way resolveAndContain
  // will (grants.resolveBase, then cwd) — used for the denylist floor below.
  // Note `cwd` only anchors a RELATIVE candidate here; it is NOT a confinement
  // base (see the unconfined short-circuit below).
  const resolvedAbs = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(grants.resolveBase ?? cwd ?? process.cwd(), candidate);

  // (1) Unconditional read-denylist floor. Secret/credential paths (~/.ssh,
  // ~/.afk/config, …) are blocked outright for reads — never prompted, never
  // bypassed — for top-level sessions and forks alike. Mirrors the floor in
  // resolveAndContain (_cwd-utils.ts) so the hook blocks cleanly instead of
  // prompting-then-letting-the-handler-throw. `~/.afk/state` is intentionally
  // NOT denied (forks legitimately read skill-preflight/todos/transcripts).
  if (mode === 'read') {
    const denied = isReadDenied(resolvedAbs);
    if (denied.denied) {
      // eslint-disable-next-line no-console
      console.error(
        `[path-approval] surface=${opts.surface} tool=${context.toolName} path=${resolvedAbs} outcome=read-denylist`,
      );
      return {
        decision: 'block',
        reason:
          `Access denied: ${resolvedAbs} ${PROTECTED_CREDENTIAL_PATH_MARKER} ` +
          `(${READ_DENYLIST_ENTRY_MARKER} ${denied.matched}). This path is never readable — ` +
          `it holds credentials, not task data; do not retry.`,
      };
    }
  }

  // (2) Bypass mode (bypassPermissions): no containment prompt.
  if (grants.allowAll === true) return {};

  // (3) Unconfined session: `resolveBase` is deliberately unset — a top-level
  // `afk`/`afk i` with no worktree, or a fork inheriting that read-open scope.
  // The file-tool HANDLER (resolveAndContain, _cwd-utils.ts:107-119) bypasses
  // containment for exactly this case, so the hook MUST agree. The prior
  // `resolveBase: grants.resolveBase ?? cwd` fabricated a concrete base from
  // getCwd() (the REPL wires it to `effectiveCwd ?? process.cwd()`,
  // bootstrap.ts), turning an unconfined session into a confined one whose
  // readRoots were `[]` — so EVERY typed-file read was "restricted", and forks
  // (which cannot prompt) auto-denied all of them. Honoring undefined
  // resolveBase here — matching the handler's own documented invariant — is the
  // fix for the sub-agent deny-all.
  if (grants.resolveBase === undefined) return {};

  // (4) Confined session: reproduce the handler's containment verdict. Pass
  // grants.resolveBase directly; it is defined on this branch (checked above).
  const result = wouldBeRestricted(
    candidate,
    {
      resolveBase: grants.resolveBase,
      readRoots: grants.readRoots,
      writeRoots: grants.writeRoots,
    },
    mode,
  );
  if (!result.restricted) return {};

  // A forked sub-agent has no human relationship of its own and must not prompt
  // the operator for out-of-root access — the prompt would surface on the
  // parent's REPL/Telegram handler (the elicitation router is process-wide),
  // interleaved into the parent's turn with no attribution. Auto-deny instead.
  // The fork resolves path containment against its OWN grant manager (injected
  // as `context.grantManager` by the executing session's dispatcher) — the
  // child's own composed write/read roots, not the parent's. So a path inside
  // the child's own granted roots still passes the `!restricted` check above;
  // only a path outside the child's own grants reaches here, and the sub-agent
  // reports the requirement back to its parent, which owns the surface and can
  // grant it.
  // Mirrors the `parentSessionId` self-skip used by the memory + plan-mode hooks.
  if (isSubagentContext(context)) {
    // eslint-disable-next-line no-console
    console.error(`[path-approval] surface=${opts.surface} tool=${context.toolName} path=${result.resolved} outcome=subagent-autodeny`);
    // #435: name the concrete remedy rather than implying a grant mechanism the
    // fork does not have. A fork cannot elicit, so the recovery actor is always
    // the PARENT — and because a fork's roots are fixed at dispatch, the only
    // remedy that reaches an in-flight fork is a re-dispatch. Wording + the
    // downstream byte/fingerprint contracts live in `./fork-denial-remedy.ts`.
    // Contract: the "Sub-agent path access denied:" prefix is load-bearing —
    // the `subagent-read-denial` telemetry detector (improve/scan/detectors)
    // and the denial circuit breaker (tools/denial-circuit-breaker.ts,
    // `SUBAGENT_PATH_DENIAL_REASON_PREFIX`) both key on it to recognise this
    // exact containment auto-deny. If you reword it, update those consumers too.
    return {
      decision: 'block',
      reason: buildForkPathDenialReason({ mode, resolvedPath: result.resolved }),
    };
  }

  // In-session approval cache short-circuits the prompt.
  const key = pathApprovalKey(mode, result.resolved);
  if (state.sessionApproved.has(key)) return {};

  // Dedupe concurrent prompts: if the model fires three reads of the same
  // path in one turn, we want ONE elicitation, not three. Subsequent
  // callers await the same promise and inherit its decision.
  const existing = state.inFlight.get(key);
  if (existing) return existing;

  const promptPromise = promptForApproval({
    toolName: context.toolName,
    resolvedPath: result.resolved,
    allPaths: extractAllPaths(context.toolName, input),
    capturedCwd: cwd,
    mode,
    grantManager,
    state,
    surface: opts.surface,
    ...(signal !== undefined ? { signal } : {}),
    ...(context.sessionId !== undefined ? { sessionId: context.sessionId } : {}),
  });
  state.inFlight.set(key, promptPromise);
  try {
    return await promptPromise;
  } finally {
    state.inFlight.delete(key);
  }
}

function postToolUseImpl(
  _opts: PathApprovalHookOptions,
  state: PathApprovalState,
  context: HookContext,
): HookDecision {
  if (context.event !== 'PostToolUse') return {};
  if (!TYPED_FILE_TOOLS.has(context.toolName)) return {};

  const input = context.input as Record<string, unknown> | undefined;
  if (!input) return {};
  const candidate = extractCandidatePath(context.toolName, input);
  if (candidate === undefined) return {};
  const mode: 'read' | 'write' = WRITE_TOOLS.has(context.toolName)
    ? 'write'
    : 'read';

  // Use the dispatcher-injected grant manager (same session as PreToolUse)
  // so the "Once"-grant revoke targets the manager the Pre check mutated.
  // Fall back to the closure-cached value so a PostToolUse dispatched without
  // an injected provider (SessionEnd) still finds the manager that was resolved
  // when the Pre handler ran.
  const grantManager = context.grantManager ?? state.lastSeenGrantManager;
  if (!grantManager) return {};
  const grants = grantManager.getGrants();

  // Invariant: use the cwd that was captured at PreToolUse time (stored in
  // the onceApproved entry) rather than a fresh opts.getCwd() call. A cwd
  // change between Pre and Post (worktree rename, /cwd slash command) would
  // cause the freshly-resolved key to diverge from the stored key, leaving
  // the once-grant unrevoked until SessionEnd. Using the stored cwd keeps
  // both key derivations on the same anchor and guarantees revocation.
  //
  // We need to find the entry by reconstructing the key with the STORED cwd.
  // Strategy: scan onceApproved for the entry whose (mode, candidate) matches,
  // then use its capturedCwd to reproduce the key. For the common case of a
  // single outstanding once-grant the scan is O(1); ref-counting would add
  // more complexity than the gain justifies (see TODO(once-dedup-race)).
  let onceEntry: { resolvedPath: string; mode: 'read' | 'write'; capturedCwd: string | undefined } | undefined;
  let onceKey: string | undefined;
  for (const [k, entry] of state.onceApproved) {
    if (entry.mode !== mode) continue;
    // Re-derive the path using the stored capturedCwd so we confirm this is the
    // same logical path the Pre handler resolved.
    const { resolved: reresolved } = wouldBeRestricted(
      candidate,
      {
        resolveBase: grants.resolveBase ?? entry.capturedCwd,
        readRoots: grants.readRoots,
        writeRoots: grants.writeRoots,
      },
      mode,
    );
    if (pathApprovalKey(mode, reresolved) === k) {
      onceEntry = entry;
      onceKey = k;
      break;
    }
  }
  if (!onceEntry || onceKey === undefined) return {};

  // Revoke the temporary grant. Ordered-operation invariant: revoke MUST
  // happen before we delete from `onceApproved` so a concurrent PreToolUse
  // for the same path observes a consistent state (either still approved-
  // once OR fully revoked, never the in-between window where the once entry
  // is gone but the grant root persists).
  //
  // TODO(once-dedup-race): two concurrent identical reads share one in-flight
  // "Once" prompt (see `state.inFlight` dedup in preToolUseImpl); this revoke
  // can fire after the first call completes but before a second concurrent
  // call's resolveAndContain runs, making the second call fail. Low impact
  // today (PostToolUse is fire-and-forget async, so by the time it runs the
  // concurrent handler has already passed containment). A deterministic fix
  // would ref-count Once grants per key and revoke only when the count hits 0.
  grantManager.revokeRoot(onceEntry.resolvedPath, 'tool');
  state.onceApproved.delete(onceKey);
  return {};
}

/**
 * SessionEnd safety net: revoke any "Once" grants still outstanding. Covers
 * the case where PostToolUse never ran for a once-approved call — e.g. the
 * call's signal aborted, so `dispatchPostToolUse` short-circuited on
 * `assertNotAborted` before reaching the revoke. Without this, an aborted-
 * mid-call "Once" grant silently survives as a full-session grant.
 *
 * `revokeRoot` is idempotent (no-op when the root is already gone), so a
 * double-revoke (PostToolUse already ran, then this sweep) is harmless.
 */
function sessionEndImpl(
  _opts: PathApprovalHookOptions,
  state: PathApprovalState,
  context: HookContext,
): HookDecision {
  if (context.event !== 'SessionEnd') return {};
  // SessionEnd context carries no `grantManager` (it is not a tool call).
  // Use the value cached by the last PreToolUse invocation. If the session
  // ended without ever running a PreToolUse (empty session, no file reads),
  // `lastSeenGrantManager` is undefined and onceApproved is already empty —
  // the clear() below is still correct.
  const grantManager = state.lastSeenGrantManager;
  if (grantManager) {
    for (const { resolvedPath } of state.onceApproved.values()) {
      grantManager.revokeRoot(resolvedPath, 'tool');
    }
  }
  state.onceApproved.clear();
  return {};
}

