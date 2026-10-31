/**
 * Agent tool input parsing.
 *
 * Extracted from `subagent-executor.ts` `execute()`: the `AgentInput` shape and
 * the `parseAgentInput` validator. Pure — no dependency on the executor
 * instance or its context.
 *
 * @module agent/tools/subagent/input-parse
 */

import {
  readOptional,
  readOptionalAliasString,
  readOptionalNumber,
  readOptionalString,
} from './optional-input.js';
import {
  parseAttachments,
  parseCwd,
  parseIsolation,
  parseReadRoots,
  parseWriteRoots,
} from './input-parse.roots.js';
import { isValidSshTarget } from '../../../remote/hosts.js';

export type AgentExecutionMode = 'foreground' | 'background';

export interface AgentInput {
  prompt: string;
  attachments?: string[];
  model?: string;
  /** Conversation-turn cap. `0` (the default) means unlimited — no ceiling. */
  max_turns?: number;
  /**
   * True when the caller supplied `max_turns` explicitly. Distinguishes the
   * parse-time default (0 = unlimited) from a deliberate value so a named
   * agent's `maxTurns` frontmatter can act as the default without being able
   * to override an explicit per-call budget.
   */
  max_turns_explicit: boolean;
  /**
   * Tool-use-round cap within the child's single turn (anti-hang ceiling).
   * `0` (the default) means unlimited on this dispatch path. A positive value
   * caps rounds; honored uniformly by both providers (see
   * shared/tool-loop-cap.ts).
   */
  max_tool_use_iterations?: number;
  /** True when the caller supplied `max_tool_use_iterations` explicitly. */
  max_tool_use_iterations_explicit: boolean;
  id_prefix?: string;
  /**
   * Named agent type to dispatch (`agent_type`, alias `subagent_type`).
   * Resolved against {@link SubagentExecutorContext.agentRegistry}.
   */
  agent_type?: string;
  /** Execution mode. Defaults to 'foreground' (existing await-and-return semantic). */
  mode: AgentExecutionMode;
  /**
   * Optional working directory the subagent runs in. When omitted, the child
   * inherits the parent's cwd (`SubagentManager.parentCwd`) so `afk -w`
   * worktree isolation extends transparently. When provided, must be an
   * absolute path with no `..` segments — the executor threads it into
   * `AgentConfig.cwd`, which `SubagentManager.forkSubagent` applies in
   * preference to the parent fallback (see `src/agent/subagent.ts:291-297`).
   *
   * Existence/git-worktree status is not checked at parse time — a
   * non-existent path surfaces as an ENOENT on the child's first cwd-relative
   * tool call, which the parent sees as a structured failure. Mirrors the
   * existing AgentConfig.cwd contract used by `afk interactive -w` and the
   * diagnose/farm orchestrators.
   *
   * Validation is NOT format-only, though (#740): this becomes the
   * dispatcher's `resolveBase`, which feeds the bash-restriction hook's grant
   * filter (`deriveRestrictedSubstrings`) — an ancestor-based containment
   * check that drops any credential root beneath a granted path. A filesystem
   * root, `os.homedir()`, or an ancestor of home is refused for that reason,
   * same breadth guard {@link readRoots} carries (checked on both the lexical
   * and symlink-resolved form).
   *
   * Caveat: this field affects only the dispatched child's cwd. Depth-2+
   * forks (the child itself calling `agent`) inherit through
   * `SubagentExecutorContext.cwd` set at orchestrator construction —
   * passing `cwd` here does NOT auto-propagate to recursive subagents.
   * Each level must specify `cwd` explicitly to operate in a worktree.
   */
  cwd?: string;
  /**
   * Optional extra write roots to pre-grant to the forked child (#435). By
   * default a fork's writes are confined to its cwd/worktree; the path-approval
   * hook auto-denies any write outside it and a fork cannot elicit. Passing
   * writeRoots here lets the PARENT deliberately grant additional write roots.
   * Composed WITH the child's cwd (never replaces it), so the child keeps write
   * access to its own tree. Each entry must be an absolute path with no `..`
   * segments, PLUS the same BREADTH rejection {@link cwd} and {@link readRoots}
   * carry (#740): a filesystem root, `os.homedir()`, or an ancestor of home is
   * refused, because an over-broad write root feeds the same bash-restriction
   * grant filter. Mutually exclusive with `isolation:'worktree'` (isolation's
   * contract is total confinement). Unlike the #416 read grant this is never
   * automatic — writing outside the worktree breaks isolation, so it requires
   * explicit parent intent.
   */
  writeRoots?: string[];
  /**
   * Optional extra READ roots to pre-grant to the forked child (#662). Mirrors
   * {@link writeRoots} but on the read axis: lets the PARENT grant the fork read
   * access to absolute paths OUTSIDE the repo/worktree it is confined to (e.g.
   * `~/Downloads`, a scratch data dir). ADDITIVE — composed WITH (never replaces)
   * the child's normally-inherited read scope in `forkSubagent`, so the child
   * keeps its repo/worktree/state reach AND gains the named dirs. Writes stay
   * confined. Grandchildren must be re-granted (not inherited).
   *
   * Per-entry rules (parse-time): non-empty absolute path, no `..` segment. PLUS
   * two hardening rejections: (a) breadth — a filesystem root, the home dir, or
   * an ancestor of the home dir is refused (the model must not over-grant a broad
   * root); (b) denylist — an entry that resolves into the credential floor
   * (`isReadDenied`: ~/.ssh, ~/.afk/config, …) is refused, so a grant can never
   * even attempt to shadow secrets. This is defense-in-depth ON TOP of the
   * read-time floor in `resolveAndContain` / the path-approval hook.
   *
   * An entry may be a DIRECTORY or a single FILE. A file grants exactly that
   * file (containment compares `path.relative(root, target) === ''`), which is
   * the only least-privilege way to reach home-ROOT dotfiles — `~/.zshrc`,
   * `~/.gitconfig`, `~/.tmux.conf` sit directly at `$HOME`, and `$HOME` itself
   * is refused by rule (a). Granting the enclosing dir is not an option there,
   * so file-granular grants are the intended shape, not a workaround.
   *
   * Deliberately NOT mutually exclusive with `isolation:'worktree'` — widening a
   * confined worktree fork's READS is legitimate (only WRITES break isolation).
   */
  readRoots?: string[];
  /**
   * Filesystem-isolation mode. When `'worktree'`, the executor forks the child
   * inside a fresh afk-managed git worktree (`.afk-worktrees/<slug>` on a new
   * branch) and sets the child's cwd to it, so parallel write-capable
   * subagents never collide in the shared tree. Omitted / `'none'` runs the
   * child in the parent tree (or `cwd`).
   *
   * Mutually exclusive with {@link cwd} (the executor owns the child's cwd when
   * isolating). Supported with `mode: 'background'`: the worktree is locked
   * during dispatch and unlocked+removed via `markTerminal`'s `onCleanup`
   * callback when the background job settles. Only the honored value is retained — `'none'` normalizes
   * to `undefined` (no field) so the executor's `=== 'worktree'` check is total.
   */
  isolation?: 'worktree';
  /**
   * When true, the forked child's tool surface gains the `emit_progress` tool,
   * allowing the child to push structured progress events to the parent at the
   * parent's next user-turn boundary. Opt-in per dispatch — the tool is EXCLUDED
   * (not silently no-oped) when this is not set.
   */
  progress_events?: boolean;
  /**
   * Optional remote host name or SSH target. When present, the subagent runs on
   * the named remote machine via `RemoteSubagentHandle` / SSH transport instead
   * of forking a local `AgentSession`. The value is a hosts.json key or a
   * literal `user@host` / `~/.ssh/config` alias — the same resolution that
   * `remote_agent` uses. Refused when `AFK_REMOTE_DEPTH` is set (this session
   * is itself a remote run and cannot fan out further). Risk class `high`
   * (inherits the same gate as `remote_agent`).
   */
  host?: string;
  /** Runtime-minted continuation chain id (docs/subagent-continuation.md, D7). */
  continuation_chain_id?: string;
}

/**
 * Validate and parse Agent tool input.
 * @throws if input is invalid
 */
export function parseAgentInput(input: unknown): AgentInput {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Agent tool input must be an object');
  }

  const agentInput = input as Record<string, unknown>;

  const prompt = agentInput['prompt'];
  if (typeof prompt !== 'string') {
    throw new Error('Agent tool input must have a "prompt" field of type string');
  }
  if (prompt.trim().length === 0) {
    throw new Error('Agent tool prompt cannot be empty');
  }

  // Every OPTIONAL field below is read through `optional-input.ts`, so a blank
  // (`undefined` / `null` / whitespace-only) value means "not supplied" rather
  // than "supplied invalidly" — model serializers pad optionals they do not
  // want, and reading that padding as intent trapped callers behind
  // contradictory errors (see that module's Contract note).

  const model = readOptionalString(agentInput, 'model');

  // Turn budget: default 0 = unlimited (matches AgentSession's falsy-maxTurns
  // = no-cap check in assertCanSend). A positive value caps conversation
  // turns; 0/negatives mean unlimited. No upper ceiling — the caller, or a
  // named agent's `maxTurns` frontmatter, owns any cap it wants.
  const maxTurnsValue = readOptionalNumber(agentInput, 'max_turns');
  const max_turns_explicit = maxTurnsValue !== undefined;
  const max_turns = maxTurnsValue === undefined ? 0 : Math.max(0, Math.floor(maxTurnsValue));

  // Tool-use-round budget within the single child turn (anti-hang ceiling).
  // Default 0 = unlimited on the agent-tool path; a positive value caps
  // rounds. Honored uniformly by both providers (see config-types.ts
  // maxToolUseIterations and providers/shared/tool-loop-cap.ts).
  const maxToolIterValue = readOptionalNumber(agentInput, 'max_tool_use_iterations');
  const max_tool_use_iterations_explicit = maxToolIterValue !== undefined;
  const max_tool_use_iterations =
    maxToolIterValue === undefined ? 0 : Math.max(0, Math.floor(maxToolIterValue));

  // agent_type: canonical param; `subagent_type` accepted as an alias for
  // Claude Code-ported prompts (bundled SKILL.mds already write it). When both
  // are present the canonical name wins — but a BLANK canonical no longer
  // shadows a real alias (plain `??` kept `''` because `'' !== undefined`).
  const agent_type = readOptionalAliasString(
    agentInput,
    ['agent_type', 'subagent_type'],
    'agent_type',
  )?.trim();

  const explicit_prefix = readOptionalString(agentInput, 'id_prefix');
  const id_prefix = explicit_prefix ?? agent_type ?? 'agent-tool';

  // mode: default 'foreground'. Unknown strings reject loudly rather than
  // silently coercing — a typo like "back" would be silently downgraded
  // to a foreground run, exactly the surprise this feature is built to
  // avoid.
  let mode: AgentExecutionMode = 'foreground';
  const modeValue = readOptional(agentInput, 'mode');
  if (modeValue !== undefined) {
    if (modeValue !== 'foreground' && modeValue !== 'background') {
      throw new Error(
        `Agent tool mode must be "foreground" or "background", got: ${JSON.stringify(modeValue)}`,
      );
    }
    mode = modeValue;
  }

  // Path-shaped fields delegated to named helpers in input-parse.roots.ts.
  // Each helper takes its raw value as an explicit parameter (no closures over
  // agentInput) and returns the validated, normalised value.
  const attachments = parseAttachments(readOptional(agentInput, 'attachments'), mode);

  // cwd: optional absolute path. Existence is not checked because the call
  // site is sync and any ENOENT surfaces cleanly through the child's first
  // tool call. Full rule commentary lives in AgentInput.cwd JSDoc and in
  // parseCwd (input-parse.roots.ts).
  const cwd = parseCwd(readOptionalString(agentInput, 'cwd'));

  // writeRoots: optional array of absolute paths pre-granted as extra write
  // roots to the fork (#435). Full rule commentary in AgentInput.writeRoots
  // JSDoc and parseWriteRoots (input-parse.roots.ts).
  const writeRoots = parseWriteRoots(readOptional(agentInput, 'writeRoots'));

  // readRoots: optional array of absolute paths pre-granted as extra READ roots
  // to the fork (#662). Full rule commentary in AgentInput.readRoots JSDoc and
  // parseReadRoots (input-parse.roots.ts).
  const readRoots = parseReadRoots(readOptional(agentInput, 'readRoots'));

  // isolation: optional enum. 'none' (or omitted) is a no-op and normalizes to
  // undefined so the executor's `=== 'worktree'` check is total. 'worktree'
  // asks the executor to fork the child inside a fresh managed git worktree.
  // Mutual-exclusion checks (cwd, writeRoots) are enforced inside parseIsolation.
  const isolation = parseIsolation(readOptional(agentInput, 'isolation'), cwd, writeRoots);

  // progress_events: optional boolean. Truthy enables the emit_progress tool
  // on the child. Falsy (or absent) excludes it. readOptional returns
  // undefined for missing/null/whitespace-only; treat anything truthy as true.
  const progressEventsValue = readOptional(agentInput, 'progress_events');
  const progress_events =
    progressEventsValue !== undefined && progressEventsValue !== null
      ? Boolean(progressEventsValue)
      : undefined;

  // host: optional string. When present, routes the dispatch to a remote host
  // via RemoteSubagentHandle. Validated the same way as remote_agent's `host`
  // param: must be non-empty, no leading '-' (would be mistaken for an ssh
  // flag). The hosts.json resolution and AFK_REMOTE_DEPTH refusal are
  // enforced at dispatch time in executeOnce, not at parse time, to keep this
  // parser pure (no I/O).
  const hostRaw = readOptionalString(agentInput, 'host');
  if (hostRaw !== undefined && /[\0\n\r]/.test(hostRaw)) {
    throw new Error('Agent tool `host` must not contain NUL, newline, or carriage-return.');
  }
  if (hostRaw !== undefined && hostRaw.startsWith('-')) {
    throw new Error('Agent tool `host` may not start with "-".');
  }
  if (hostRaw !== undefined && !isValidSshTarget(hostRaw)) {
    throw new Error(`Agent tool \`host\` is not a valid SSH target: ${JSON.stringify(hostRaw)}`);
  }
  // Invariant: the startsWith('-') case is already rejected by the throw
  // above, and isValidSshTarget also rejects it — so hostRaw is always a
  // valid, non-dash-prefixed target at this point.
  const host = hostRaw;
  const continuation_chain_id = readOptionalString(agentInput, 'continuation_chain_id');

  return {
    prompt,
    ...(attachments !== undefined ? { attachments } : {}),
    model,
    max_turns,
    max_turns_explicit,
    max_tool_use_iterations,
    max_tool_use_iterations_explicit,
    id_prefix,
    mode,
    ...(agent_type !== undefined ? { agent_type } : {}),
    ...(cwd !== undefined ? { cwd } : {}),
    ...(writeRoots !== undefined ? { writeRoots } : {}),
    ...(readRoots !== undefined ? { readRoots } : {}),
    ...(isolation !== undefined ? { isolation } : {}),
    ...(progress_events !== undefined ? { progress_events } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(continuation_chain_id !== undefined ? { continuation_chain_id } : {}),
  };
}
