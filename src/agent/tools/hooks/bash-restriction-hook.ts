/**
 * PreToolUse hook that blocks bash invocations referencing restricted paths,
 * plus interpreter `-c`/`-e` one-liners that reference those same sensitive
 * paths.
 *
 * # Invariant — threat model (load-bearing)
 *
 * This hook prevents ACCIDENTAL access to sensitive paths by a non-adversarial
 * model. It is NOT a security boundary against an actively adversarial model.
 *
 * Bash is Turing-complete and any string-based filter has known bypasses:
 *   - Variable assembly:        `H=$HOME; cat $H/.ssh/id_rsa`
 *   - Brace expansion:          `cat /etc/{passwd,shadow}`
 *   - Process substitution:     `cat <(echo /etc/passwd)`
 *   - File descriptor tricks:   `exec 3</etc/passwd; cat <&3`
 *   - String-split obfuscation: `python -c "open('~/.s'+'sh/id_rsa')"`
 *
 * These are accepted as residual risk for the accidental-prevention threat
 * model. For adversarial containment, run agent-afk inside an OS-level sandbox:
 *   - macOS:  `sandbox-exec` (note: deprecated in newer Xcode releases)
 *   - Linux:  Landlock or seccomp via systemd, bubblewrap, firejail
 *   - Docker: drop --cap-add and mount only the workspace
 *
 * # What this hook does
 *
 * 1. Reads the bash `command` string from the tool input.
 * 2. INTERPRETER-EVAL GUARD (check 1): if the command is an interpreter
 *    one-liner (`python -c`, `node -e`, `ruby -e`, `sh -c`, ...) AND the
 *    payload references a sensitive path — a grant-filtered restricted root, or
 *    a credential fragment like `.ssh` / `id_rsa` / `.aws` / `/etc/shadow` that
 *    an interpreter can assemble at runtime (see `SENSITIVE_PATH_SIGNAL`) — AND
 *    an interactive approval path exists (a grant manager is wired — REPL or
 *    Telegram), block with redirect guidance. This is deliberately NARROW:
 *    pure-computation one-liners (`python -c 'print(2**64)'`, `node -e
 *    'console.log(1)'`) are NOT blocked — they touch no sensitive path, so the
 *    block was pure friction with no safety value. The guard exists to close
 *    the one thing check 2's literal-substring scan cannot see: an interpreter
 *    building a credential path at runtime (`open(expanduser('~/.ssh/id_rsa'))`).
 *    Headless surfaces (afk chat, daemon, threads, subagents of headless
 *    sessions) fail OPEN by default, because the "use typed file tools" advice
 *    is only actionable where a human can approve the prompt; opt back in with
 *    AFK_FORCE_BASH_INTERPRETER_GUARD=1, or lift it entirely with
 *    AFK_DISABLE_BASH_INTERPRETER_GUARD=1.
 * 3. RESTRICTED-ROOT SUBSTRING GUARD (check 2): if the command contains a
 *    literal substring referencing a restricted root (any sensitive path NOT
 *    inside the session's grant lists), block with redirect guidance pointing
 *    the model at typed file tools.
 *
 * # History (why check 1 is scoped, not blanket)
 *
 * Check 1 previously hard-blocked EVERY interpreter `-c`/`-e` one-liner
 * regardless of payload. That over-broad default was the single highest-
 * frequency source of self-inflicted agent friction (harmless computation
 * one-liners blocked constantly), which predictably drove operators to disable
 * the guard wholesale via AFK_DISABLE_BASH_INTERPRETER_GUARD=1 — silencing its
 * genuine, narrow value. Scoping check 1 to credential-adjacent payloads keeps
 * the protection live by no longer crying wolf. The pinned expectations live in
 * `bash-restriction-hook.test.ts`.
 *
 * The block reason is **structured** — the model sees "use read_file /
 * write_file / edit_file, they support per-call approval" — so it routes
 * back to the prompt-able surface instead of looking for another escape
 * hatch.
 *
 * @module agent/tools/hooks/bash-restriction-hook
 */

import { homedir } from 'os';
import path from 'path';
import type { GrantManager } from '../../../cli/slash/commands/allow-dir.js';
import type { HookContext, HookDecision } from '../../hooks.js';

/**
 * Interpreter denylist regex. Matches `<interpreter> -<flag>` where flag is
 * the eval-from-string variant (`-c`/`-C`/`-e`/`-E`) common across shells
 * and scripting languages. Anchored with `\b` so a path containing the
 * literal `python3` (e.g. `/usr/local/bin/python3-config`) does not match.
 *
 * This regex only identifies that a command IS an interpreter one-liner; it is
 * necessary but NOT sufficient to block. Check 1 blocks only when this matches
 * AND `referencesSensitivePath()` is also true (see the factory below and the
 * module header) — so `python -c 'print(2**64)'` passes while
 * `python -c "open(expanduser('~/.ssh/id_rsa'))"` is caught.
 */
const INTERPRETER_DENYLIST =
  /\b(python|python3|node|ruby|perl|osascript|sh|bash|zsh|fish|lua)\s+-[cCeE](\s|$)/;

/**
 * Credential-path fragments that survive runtime home-dir assembly. Kept in
 * sync with the sensitive roots in `deriveRestrictedSubstrings`, but expressed
 * as trailing fragments (plus private-key filenames and the browser-profile root) so they
 * match even when an interpreter assembles the home prefix at runtime
 * (`os.environ['HOME']+'/.ssh'`, `expanduser('~/.ssh')`) — the exact case
 * check 2's literal `~`/`$HOME` normalization cannot see. Word-boundary
 * anchored to curb false positives (`.awstats`, `foo.sshconfig` do not match).
 *
 * `/etc/passwd` is deliberately ABSENT — it is world-readable and carries no
 * secret; the secret companion `/etc/shadow` IS covered. This is the calibration
 * that lets benign one-liners through while still catching credential access.
 */
export const SENSITIVE_PATH_SIGNAL =
  /\.ssh\b|\bid_rsa\b|\bid_ed25519\b|\.gnupg\b|\.aws\b|\.config\/gh\b|\.netrc\b|\.password-store\b|Library\/Application Support\b|\/etc\/shadow\b|\/etc\/sudoers\b/i;

export interface BashRestrictionHookOptions {
  /**
   * Returns the active grant manager (provider). Used to read the current
   * grant snapshot so the substring check knows which paths are trusted.
   * Returns undefined during the bootstrap race; in that case the hook
   * fails open (no bash restriction) because blocking on bootstrap would
   * leave the user unable to recover.
   */
  getGrantManager: () => GrantManager | undefined;
  /**
   * When true, skip the interpreter-eval denylist (check 1 below). The
   * restricted-root substring check (check 2) is unaffected. Wired from
   * `AFK_DISABLE_BASH_INTERPRETER_GUARD=1` so an operator whose headless
   * automation legitimately runs `python -c` / `sh -c` one-liners can lift
   * just the interpreter block without disabling all of path-approval
   * (`AFK_DISABLE_PATH_APPROVAL=1`). Default false (guard active on
   * interactive surfaces). When both this and `forceInterpreterGuard` are set,
   * this wins (explicit OFF beats opt-in ON).
   */
  disableInterpreterGuard?: boolean;
  /**
   * When true, apply the interpreter-eval denylist even on headless surfaces
   * where no grant manager is wired. By default the denylist fires ONLY on
   * interactive surfaces (a wired grant manager signals an approval path the
   * model can be redirected to); on headless surfaces it fails open so
   * legitimate automation (`python -c`, `sh -c`, …) is not hard-blocked with
   * no recourse. Wired from `AFK_FORCE_BASH_INTERPRETER_GUARD=1` for operators
   * who want the guard active in headless flows too. Overridden by
   * `disableInterpreterGuard`. Default false.
   */
  forceInterpreterGuard?: boolean;
}

/**
 * Factory. Returns a synchronous `HookHandler` — bash restriction is
 * regex-based with no I/O, so we do not need the longRunning escape.
 */
export function createBashRestrictionHook(opts: BashRestrictionHookOptions) {
  return (context: HookContext): HookDecision => {
    if (context.event !== 'PreToolUse') return {};
    if (context.toolName !== 'bash') return {};

    const input = context.input as Record<string, unknown> | undefined;
    const command = typeof input?.['command'] === 'string' ? input['command'] : '';
    if (!command) return {};

    // Fetch the grant manager once. Its presence doubles as the "interactive
    // surface" signal: only the REPL and Telegram bootstraps wire it (see
    // default-hook-registry.ts), so a wired manager means an interactive
    // approval path exists that the model can be redirected to. Headless
    // surfaces (afk chat, daemon, threads, subagents of headless sessions)
    // never wire it.
    //
    // Prefer the dispatcher-injected grant manager (this session's provider)
    // over the process-global ref so a forked child's restricted-root view is
    // derived from ITS own grants, not the top-level session's (#435/#514).
    // The ref remains the fallback when no dispatcher injected one.
    const grantManager = context.grantManager ?? opts.getGrantManager();
    const interactiveSurface = grantManager !== undefined;

    // Precompute the sensitive-path view ONCE — both checks below consume it.
    // `normalized` resolves the obvious `~` / `$HOME` shell idioms to the real
    // home dir (NOT a parser — variable-assembled paths are out of scope; see
    // module header). `restrictedSubstrings` is the grant-filtered set of
    // sensitive roots; it is empty when no grant manager is wired (headless),
    // so check 2 fails open there and check 1 falls back to the lexical signal.
    const home = homedir();
    const normalized = normalizeHomeRefs(command, home);
    const restrictedSubstrings = grantManager
      ? deriveRestrictedSubstrings(grantManager.getGrants())
      : [];

    // 1. Interpreter-eval guard — hard block, SCOPED to credential-adjacent
    // one-liners.
    //
    // Invariant: the interpreter guard fires ONLY where (a) redirection is
    // actionable and (b) the eval payload actually references a sensitive path.
    // (a) The block reason tells the model to "use typed file tools, which
    // support per-call approval" — advice that only works on an interactive
    // surface (a wired grant manager), so we require `interactiveSurface`,
    // matching check 2 which also fails open on headless.
    // (b) `referencesSensitivePath` scopes the block so pure-computation
    // one-liners pass — that scoping is the calibration; see the module header
    // History note. Overrides:
    //   - AFK_DISABLE_BASH_INTERPRETER_GUARD=1 (`disableInterpreterGuard`)
    //     forces it OFF even on interactive surfaces — and wins over force;
    //   - AFK_FORCE_BASH_INTERPRETER_GUARD=1 (`forceInterpreterGuard`) forces
    //     it ON even on headless surfaces (where `restrictedSubstrings` is
    //     empty, so only the lexical SENSITIVE_PATH_SIGNAL applies).
    const interpreterGuardActive =
      !opts.disableInterpreterGuard &&
      (interactiveSurface || opts.forceInterpreterGuard === true);
    if (
      interpreterGuardActive &&
      INTERPRETER_DENYLIST.test(command) &&
      referencesSensitivePath(normalized, command, restrictedSubstrings)
    ) {
      return {
        decision: 'block',
        reason:
          'Interpreter one-liner (python -c, node -e, sh -c, ...) referencing a sensitive path ' +
          '(SSH keys, cloud credentials, GPG, /etc/shadow, ...) is blocked by the path-approval ' +
          'policy — an interpreter can assemble a path the shell-substring check cannot see. Use ' +
          'the typed file tools (read_file, write_file, edit_file), which support per-call user ' +
          'approval, or ask the user to run the script themselves. To lift this block — e.g. ' +
          'headless automation that legitimately reads such paths — set ' +
          'AFK_DISABLE_BASH_INTERPRETER_GUARD=1, or disable all of path-approval with ' +
          'AFK_DISABLE_PATH_APPROVAL=1.',
      };
    }

    // 2. Restricted-root substring check.
    // Only fires when a grant manager is wired (during the bootstrap race and
    // on headless surfaces we fail open). The check is intentionally crude:
    // literal `normalized.includes` against every "restricted directory" we can
    // derive. False positives (echo "see ~/.ssh/config") block the bash call
    // and ask the model to explain what it was doing, which is acceptable for
    // the accidental threat model.
    //
    // Invariant: on headless surfaces (afk chat, daemon, threads) the grant
    // manager is NEVER wired, so BOTH this substring check AND the interpreter
    // denylist above fail open here — bash is NOT restricted on headless (it
    // has no resolveAndContain backstop like the typed file tools do). Accepted
    // residual risk under the non-adversarial threat model (see module header);
    // for stricter headless containment use an OS-level sandbox, or opt the
    // interpreter guard back in with AFK_FORCE_BASH_INTERPRETER_GUARD=1.
    if (!grantManager) return {};
    if (restrictedSubstrings.length === 0) return {};

    for (const sub of restrictedSubstrings) {
      if (normalized.includes(sub)) {
        return {
          decision: 'block',
          reason:
            `Bash command references a restricted path (${sub}). ` +
            'For sensitive paths, use read_file / write_file / edit_file — ' +
            'those tools support per-call user approval via an inline prompt. ' +
            'If you genuinely need a shell command for this path, ask the user ' +
            'to grant it via `/allow-dir <path>` first.',
        };
      }
    }

    return {};
  };
}

/**
 * Normalize the obvious `~` and `$HOME` shell idioms to the real home dir so
 * the substring checks catch the non-adversarial accident case. NOT a parser —
 * variable-assembled paths (`H=$HOME; …$H/…`) are intentionally out of scope
 * (see module-header threat model). Shared by both checks.
 */
function normalizeHomeRefs(command: string, home: string): string {
  return command
    .replace(/\$HOME/g, home)
    .replace(/(^|[\s/=:])~(?=$|[/\s])/g, `$1${home}`);
}

/**
 * True when a command references a sensitive location the path-approval policy
 * protects — via either the grant-filtered restricted substrings (literal /
 * `~` / `$HOME` forms, same as check 2) or the lexical credential-fragment
 * signal (which catches interpreter-assembled paths the literal scan misses).
 * Used to scope the interpreter-eval guard (check 1) so it fires only on
 * credential-adjacent one-liners, not on every `-c`/`-e` invocation.
 */
function referencesSensitivePath(
  normalized: string,
  rawCommand: string,
  restrictedSubstrings: string[],
): boolean {
  if (restrictedSubstrings.some((sub) => normalized.includes(sub))) return true;
  return SENSITIVE_PATH_SIGNAL.test(rawCommand);
}

/**
 * Derive a set of sensitive-path substrings to scan bash commands for.
 *
 * Heuristic: we want to block paths the user has NOT explicitly granted that
 * are likely to contain sensitive material. We do NOT want to block every
 * path outside the cwd — that would break `ls /etc`, `which git`, etc.
 *
 * The current allow-listed sensitive prefixes are common high-signal targets:
 * SSH keys, GPG, AWS, browser profiles, password stores, environment files.
 * Each is included only when the user's resolveBase is NOT already inside it
 * (so a user working in `~/.ssh` doesn't self-block).
 */
export function deriveRestrictedSubstrings(grants: {
  resolveBase: string | undefined;
  readRoots: string[];
  writeRoots: string[];
}): string[] {
  const home = homedir();
  const candidates = [
    path.join(home, '.ssh'),
    path.join(home, '.gnupg'),
    path.join(home, '.aws'),
    path.join(home, '.config', 'gh'),
    path.join(home, '.netrc'),
    path.join(home, 'Library', 'Application Support'),
    path.join(home, '.password-store'),
    '/etc/shadow',
    '/etc/sudoers',
    '/private/etc/sudoers',
  ];

  const granted = new Set([
    ...(grants.resolveBase !== undefined ? [grants.resolveBase] : []),
    ...grants.readRoots,
    ...grants.writeRoots,
  ]);

  // Filter: drop a candidate only when the user has actually granted access
  // to ALL of it — i.e. a granted root IS the candidate or is an ANCESTOR of
  // it. Containment direction matters: `path.relative(g, c)` not starting
  // with `..` means c is at-or-inside g (g covers c). Using the candidate as
  // the `from` arg (the prior bug) instead matched when g was a CHILD of c,
  // so granting a narrow subdir (e.g. ~/Library/Application Support/Cursor/User)
  // wrongly un-gated the whole sensitive parent (~/Library/Application Support)
  // and every sibling app dir under it.
  return candidates.filter((c) => {
    for (const g of granted) {
      const rel = path.relative(g, c);
      if (rel === '' || !rel.startsWith('..')) return false;
    }
    return true;
  });
}
