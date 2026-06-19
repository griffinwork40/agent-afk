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

import { elicitationRouter } from '../../elicitation-router.js';
import type { GrantManager } from '../../../cli/slash/commands/allow-dir.js';
import { wouldBeRestricted, realpathSafe } from '../handlers/_cwd-utils.js';
import { appendGrant } from '../../permissions-store.js';
import type { HookContext, HookDecision, HookHandler } from '../../hooks.js';

/** Tools subject to per-call path approval. Bash is gated separately. */
const TYPED_FILE_TOOLS = new Set([
  'read_file',
  'write_file',
  'edit_file',
  'list_directory',
  'glob',
  'grep',
]);

/** Tools that write — used to pick read-vs-write containment + grant mode. */
const WRITE_TOOLS = new Set(['write_file', 'edit_file']);

/** Surface label threaded into the persisted grant for audit. */
export type PathApprovalSurface = 'repl' | 'telegram' | 'unknown';

export interface PathApprovalHookOptions {
  /**
   * Returns the active grant manager (provider instance) or undefined if not
   * yet wired (e.g. session bootstrap is racing with the first tool call).
   * When undefined, the hook fails open (skip approval) so headless/one-shot
   * surfaces without a wire-up step keep working with the existing handler
   * `resolveAndContain` enforcement.
   */
  getGrantManager: () => GrantManager | undefined;
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
interface PathApprovalState {
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
  const grantManager = opts.getGrantManager();
  if (!grantManager) {
    // Failsafe — no wired grant manager (headless, one-shot, daemon). Skip
    // the approval pre-check and let the handler's own resolveAndContain
    // enforce containment as it does today. Documented in module header.
    return {};
  }
  const grants = grantManager.getGrants();
  // Invariant: capture cwd ONCE here and thread it into the onceApproved
  // entry. postToolUseImpl reuses this stored value (not a fresh getCwd())
  // so a cwd change between Pre and Post (worktree rename, /cwd command)
  // cannot cause the revoke to miss the correct key.
  const cwd = opts.getCwd();
  const result = wouldBeRestricted(
    candidate,
    {
      cwd,
      resolveBase: grants.resolveBase ?? cwd,
      readRoots: grants.readRoots,
      writeRoots: grants.writeRoots,
      ...(grants.allowAll === true ? { allowAll: true } : {}),
    },
    mode,
  );
  // Bypass mode: `allowAll` makes wouldBeRestricted return not-restricted, so
  // this returns {} here — no prompt. (Belt-and-suspenders with the explicit
  // flag pass-through above.)
  if (!result.restricted) return {};

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
    capturedCwd: cwd,
    mode,
    grantManager,
    state,
    surface: opts.surface,
    ...(signal !== undefined ? { signal } : {}),
  });
  state.inFlight.set(key, promptPromise);
  try {
    return await promptPromise;
  } finally {
    state.inFlight.delete(key);
  }
}

function postToolUseImpl(
  opts: PathApprovalHookOptions,
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

  const grantManager = opts.getGrantManager();
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
    // Re-derive the path using the stored cwd so we confirm this is the same
    // logical path the Pre handler resolved.
    const { resolved: reresolved } = wouldBeRestricted(
      candidate,
      {
        cwd: entry.capturedCwd,
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
  opts: PathApprovalHookOptions,
  state: PathApprovalState,
  context: HookContext,
): HookDecision {
  if (context.event !== 'SessionEnd') return {};
  const grantManager = opts.getGrantManager();
  if (grantManager) {
    for (const { resolvedPath } of state.onceApproved.values()) {
      grantManager.revokeRoot(resolvedPath, 'tool');
    }
  }
  state.onceApproved.clear();
  return {};
}

/**
 * Extract the path argument from a typed file-tool input. Returns undefined
 * when no path is present (e.g. glob without explicit `path`, which falls
 * back to cwd and is therefore inside the resolveBase).
 */
function extractCandidatePath(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  // read_file / write_file / edit_file all use `file_path`.
  if (
    toolName === 'read_file' ||
    toolName === 'write_file' ||
    toolName === 'edit_file'
  ) {
    const p = input['file_path'];
    return typeof p === 'string' ? p : undefined;
  }
  // list_directory uses `path`.
  if (toolName === 'list_directory') {
    const p = input['path'];
    return typeof p === 'string' ? p : undefined;
  }
  // glob/grep — `path` is optional. When absent, the handler uses cwd which
  // is trusted; return undefined so we skip the prompt.
  if (toolName === 'glob' || toolName === 'grep') {
    const p = input['path'];
    return typeof p === 'string' ? p : undefined;
  }
  return undefined;
}

/**
 * Issue the elicitation prompt and translate the response into a hook
 * decision + grant mutation.
 */
async function promptForApproval(args: {
  toolName: string;
  resolvedPath: string;
  /** cwd captured at PreToolUse time; stored in the onceApproved entry. */
  capturedCwd: string | undefined;
  mode: 'read' | 'write';
  grantManager: GrantManager;
  state: PathApprovalState;
  surface: PathApprovalSurface;
  /** Turn/dispatch abort signal — cancels the pending prompt on teardown. */
  signal?: AbortSignal;
}): Promise<HookDecision> {
  const { toolName, resolvedPath, capturedCwd, mode, grantManager, state, surface, signal } = args;

  // Show the symlink-resolved target when it differs from the displayed path so
  // the consent decision reflects the REAL destination — a workspace symlink
  // pointing outside (e.g. `./link -> /etc`) would otherwise be approved under
  // its innocuous symlink label. realpathSafe never throws (it resolves the
  // nearest existing ancestor for not-yet-created write targets).
  const realTarget = realpathSafe(resolvedPath);
  const realTargetSuffix = realTarget !== resolvedPath ? `\n  (resolves to: ${realTarget})` : '';
  const message =
    `Tool \`${toolName}\` wants to ${mode === 'write' ? 'WRITE to' : 'read'} a path ` +
    `outside this session's granted roots:\n\n  ${resolvedPath}${realTargetSuffix}\n\n` +
    `Choose how to handle this and future requests for this path.`;

  // Form-mode elicitation with a single enum field, four choices. The REPL
  // and Telegram handlers know how to render this (REPL: numbered prompt;
  // Telegram: inline keyboard).
  const result = await elicitationRouter.route(
    {
      serverName: 'agent-afk',
      message,
      mode: 'form',
      title: 'Path access approval',
      requestedSchema: {
        type: 'object',
        properties: {
          choice: {
            type: 'string',
            title: 'Choose one',
            enum: ['once', 'session', 'persist', 'deny'],
            description:
              "'once' allows this single call only. 'session' allows this path until the session ends. " +
              "'persist' writes a grant to ~/.afk/config/permissions.json so future sessions inherit it. " +
              "'deny' blocks this call and returns an error to the model.",
          },
        },
        required: ['choice'],
      },
    },
    // The elicitation router has NO time-based deadline — a path-approval
    // prompt waits as long as the operator needs (the 5-min auto-decline was
    // deliberately removed; it cut off AFK operators who stepped away). The
    // hook's `longRunning` flag prevents the registry's 30s timeout from
    // firing, so the ONLY unblock-on-teardown path is the turn/dispatch
    // signal forwarded here. Falling back to a never-aborting signal (no
    // forwarded signal) preserves prior behavior for surfaces/tests that
    // dispatch without one.
    { signal: signal ?? new AbortController().signal },
  );

  if (result.action !== 'accept') {
    const outcome = result.action === 'cancel' ? 'cancel' : 'block';
    // eslint-disable-next-line no-console
    console.error(
      `[path-approval] surface=${surface} tool=${toolName} path=${resolvedPath} outcome=${outcome}`,
    );
    return {
      decision: 'block',
      reason:
        result.action === 'cancel'
          ? `User cancelled the access prompt for ${resolvedPath}`
          : `User denied access to ${resolvedPath}`,
    };
  }

  const choice = String(result.content?.['choice'] ?? '').toLowerCase();
  const key = pathApprovalKey(mode, resolvedPath);

  switch (choice) {
    case 'once':
      // Add to grant lists so resolveAndContain passes, AND record in the
      // once-approved map so the PostToolUse hook revokes after the call.
      // Invariant: addReadRoot/addWriteRoot must precede the onceApproved
      // map write so an interleaved PostToolUse cannot revoke before the
      // pre-handler check sees the grant. Ordered-operation invariant per
      // AFK.md.
      //
      // capturedCwd is stored in the entry so postToolUseImpl can reconstruct
      // the key using the SAME cwd anchor even if opts.getCwd() drifts between
      // Pre and Post (M1 cwd-divergence fix).
      if (mode === 'write') {
        grantManager.addWriteRoot(resolvedPath, 'tool');
      } else {
        grantManager.addReadRoot(resolvedPath, 'tool');
      }
      state.onceApproved.set(key, { resolvedPath, mode, capturedCwd });
      // eslint-disable-next-line no-console
      console.error(
        `[path-approval] surface=${surface} tool=${toolName} path=${resolvedPath} outcome=once`,
      );
      return {};

    case 'session':
      // Mutate the in-memory grant lists (no persistence). Also cache the
      // (mode, path) key so subsequent calls in the same session don't
      // re-prompt even if the model passes the path through a different
      // tool that resolves to the same absolute.
      if (mode === 'write') {
        grantManager.addWriteRoot(resolvedPath, 'tool');
      } else {
        grantManager.addReadRoot(resolvedPath, 'tool');
      }
      state.sessionApproved.add(key);
      // eslint-disable-next-line no-console
      console.error(
        `[path-approval] surface=${surface} tool=${toolName} path=${resolvedPath} outcome=session`,
      );
      return {};

    case 'persist':
      // Same as session, plus write to ~/.afk/config/permissions.json.
      if (mode === 'write') {
        grantManager.addWriteRoot(resolvedPath, 'tool');
      } else {
        grantManager.addReadRoot(resolvedPath, 'tool');
      }
      state.sessionApproved.add(key);
      // eslint-disable-next-line no-console
      console.error(
        `[path-approval] surface=${surface} tool=${toolName} path=${resolvedPath} outcome=persist`,
      );
      try {
        appendGrant({
          path: resolvedPath,
          mode,
          decision: 'allow',
          source:
            surface === 'telegram'
              ? 'elicit:telegram'
              : surface === 'repl'
                ? 'elicit:repl'
                : 'elicit:unknown',
          reason: `Approved via ${surface} prompt for ${toolName}`,
        });
      } catch (err) {
        // Persistence is best-effort. We still honor the in-session grant —
        // the user already approved. Log to stderr; the dispatcher has no
        // structured logger here.
        // eslint-disable-next-line no-console
        console.error(
          `path-approval: failed to persist grant for ${resolvedPath}:`,
          err instanceof Error ? err.message : String(err),
        );
      }
      return {};

    case 'deny':
    default:
      // eslint-disable-next-line no-console
      console.error(
        `[path-approval] surface=${surface} tool=${toolName} path=${resolvedPath} outcome=deny`,
      );
      return {
        decision: 'block',
        reason: `User denied access to ${resolvedPath}`,
      };
  }
}
