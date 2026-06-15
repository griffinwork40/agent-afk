/**
 * PreToolUse hook that blocks bash invocations referencing restricted paths
 * or evaluating arbitrary code via interpreter `-c`/`-e` flags.
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
 *   - Interpreter scripts:      `python -c "open('/etc/passwd').read()"`
 *
 * The interpreter denylist below closes the most obvious adjacent bypass
 * (interpreter scripts). The rest are accepted as residual risk for the
 * accidental-prevention threat model.
 *
 * For adversarial containment, run agent-afk inside an OS-level sandbox:
 *   - macOS:  `sandbox-exec` (note: deprecated in newer Xcode releases)
 *   - Linux:  Landlock or seccomp via systemd, bubblewrap, firejail
 *   - Docker: drop --cap-add and mount only the workspace
 *
 * # What this hook does
 *
 * 1. Reads the bash `command` string from the tool input.
 * 2. If the command matches the interpreter denylist (`python -c`, `node -e`,
 *    `ruby -e`, `osascript -e`, `sh -c`, `bash -c`, `zsh -c`, `fish -c`),
 *    block with redirect guidance.
 * 3. If the command contains a literal substring referencing a restricted
 *    root (any path NOT inside the session's grant lists), block with
 *    redirect guidance pointing the model at typed file tools.
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
 * Note: this is a hard-block — no elicitation — because:
 *   (a) the user cannot reasonably audit an arbitrary shell-script string
 *       inside a prompt; clicking [Allow] would be a reflex, not a
 *       considered decision (the architect's "training-wheels" critique);
 *   (b) the model can almost always re-route via typed tools instead.
 *
 * If the user genuinely needs to run an interpreter script, they can do it
 * outside the agent. The agent's escape hatch is to ask the user explicitly,
 * not to evaluate code on the user's behalf.
 */
const INTERPRETER_DENYLIST =
  /\b(python|python3|node|ruby|perl|osascript|sh|bash|zsh|fish|tclsh|lua)\s+-[cCeE](\s|$)/;

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
   * (`AFK_DISABLE_PATH_APPROVAL=1`). Default false (guard active).
   */
  disableInterpreterGuard?: boolean;
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

    // 1. Interpreter denylist — hard block. Fires before the grant-manager
    // gate below, so by default it applies on every surface — including
    // headless ones (afk chat, daemon, threads) where no grant manager is
    // wired. On those surfaces there is no interactive approval path, so the
    // "use typed file tools" advice is only actionable interactively. The
    // granular escape is AFK_DISABLE_BASH_INTERPRETER_GUARD=1 (lifts only this
    // check, threaded in as `disableInterpreterGuard`); AFK_DISABLE_PATH_APPROVAL=1
    // disables the whole feature.
    if (!opts.disableInterpreterGuard && INTERPRETER_DENYLIST.test(command)) {
      return {
        decision: 'block',
        reason:
          'Interpreter-with-eval flags (python -c, node -e, ruby -e, sh -c, ...) are blocked by ' +
          'the path-approval policy. On interactive surfaces, use the typed file tools (read_file, ' +
          'write_file, edit_file) which support per-call user approval, or ask the user to run the ' +
          'script themselves. To lift this block — e.g. headless automation that legitimately runs ' +
          'interpreter one-liners — set AFK_DISABLE_BASH_INTERPRETER_GUARD=1, or disable all of ' +
          'path-approval with AFK_DISABLE_PATH_APPROVAL=1.',
      };
    }

    // 2. Restricted-root substring check.
    // Only fires when a grant manager is wired (during bootstrap race we
    // fail open). The check is intentionally crude: literal `command.includes`
    // against every "restricted directory" we can derive. False positives
    // (echo "see ~/.ssh/config") block the bash call and ask the model to
    // explain what it was doing, which is acceptable for the accidental
    // threat model.
    //
    // Invariant: on headless surfaces (afk chat, daemon, threads) the grant
    // manager is NEVER wired, so this substring check always fails open here —
    // bash referencing a restricted path is NOT blocked on headless (bash has
    // no resolveAndContain backstop like the typed file tools do). Accepted
    // residual risk under the non-adversarial threat model (see module header);
    // for stricter headless containment use an OS-level sandbox. The
    // interpreter denylist (check 1) is unaffected — it fires regardless.
    const grantManager = opts.getGrantManager();
    if (!grantManager) return {};
    const grants = grantManager.getGrants();
    const restrictedSubstrings = deriveRestrictedSubstrings(grants);
    if (restrictedSubstrings.length === 0) return {};

    // Normalize `~` and `$HOME` in the command to the real home dir for the
    // substring match. This catches the obvious-shell-idiom case without
    // pretending to be a real parser.
    const home = homedir();
    const normalized = command
      .replace(/\$HOME/g, home)
      .replace(/(^|[\s/=:])~(?=$|[/\s])/g, `$1${home}`);

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
function deriveRestrictedSubstrings(grants: {
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
