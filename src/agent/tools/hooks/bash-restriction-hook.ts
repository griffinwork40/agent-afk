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
 * The restricted roots are the typed-tool read denylist (`read-denylist.ts`)
 * plus a few bash-only extras — one shared list, so a credential path floored
 * for `read_file` is floored for `cat` too, and its exact-file carve-outs
 * (`~/.afk/config/mcp.json`) stay readable on both surfaces. See
 * {@link builtinBashSensitiveRoots} for what each half contributes and
 * {@link deriveRestrictedSubstrings} for the one deliberate divergence (bash
 * filters by grants; the typed floor is unconditional).
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
import {
  BUILTIN_READ_DENYLIST,
  READ_ALLOWLIST_REL,
  getReadDenylist,
  isReadDenied,
  parseReadDenylistEntries,
} from '../handlers/read-denylist.js';
import { env } from '../../../config/env.js';
import { textMentionsPath } from '../fs-case.js';
import {
  configuredAfkHome,
  afkAllowlistFileForms,
  relocatedAfkSensitiveRoots,
} from './afk-home-refs.js';
import { escapeRegExp } from '../../../utils/regexp.js';

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
 *
 * The `.afk/config` fragment covers AFK's own credential tree (`afk.env` API
 * keys, an `afk.config.json` that may carry a literal `apiKey`) and is anchored
 * to `config` so the sibling `~/.afk/state` — which sub-agents legitimately read
 * (skill-preflight inputs, todos, transcripts) — stays untouched. The registry
 * carve-out `~/.afk/config/mcp.json` is handled upstream of this regex, by
 * {@link scrubAllowlistedRefs}, so it needs no exception here.
 */
export const SENSITIVE_PATH_SIGNAL =
  /\.ssh\b|\bid_rsa\b|\bid_ed25519\b|\.gnupg\b|\.aws\b|\.config\/gh\b|\.config\/gcloud\b|\.netrc\b|\.password-store\b|\.afk\/config\b|\.npmrc\b|\.docker\/config\.json\b|\.git-credentials\b|\.kube\/config\b|Library\/Application Support\b|\/etc\/shadow\b|\/etc\/sudoers\b|master\.passwd\b|Library\/LaunchAgents\b|Library\/LaunchDaemons\b|\.config\/systemd\b/i;

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
 * Factory. Returns a synchronous `HookHandler`. Bash restriction is mostly
 * regex-based, but the carve-out filter (`allowlistedFileForms` →
 * `isReadDenied` → `safeRealpath`) does a bounded `realpathSync` per call, one
 * per allowlisted form — it stays synchronous deliberately (the I/O is a
 * handful of stat-like syscalls, not worth an async escape), so we still do
 * not need the longRunning flag.
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
    // `scanned` resolves the obvious `~` / `$HOME` shell idioms to the real home
    // dir (NOT a parser — variable-assembled paths are out of scope; see module
    // header), then blanks out the read denylist's exact-file carve-outs so a
    // legitimate `cat ~/.afk/config/mcp.json` does not trip the enclosing
    // `~/.afk/config` root. Both checks scan this same string, so the carve-out
    // cannot apply to one and not the other. `restrictedSubstrings` is the
    // grant-filtered set of sensitive roots; it is empty when no grant manager
    // is wired (headless), so check 2 fails open there and check 1 falls back to
    // the lexical signal.
    const home = homedir();
    const afkHome = configuredAfkHome();
    const scanned = scrubAllowlistedRefs(normalizeHomeRefs(command, home, afkHome), home, afkHome);
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
      referencesSensitivePath(scanned, restrictedSubstrings)
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
    // literal `scanned.includes` against every "restricted directory" we can
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
      if (textMentionsPath(scanned, sub)) {
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
 *
 * Invariant: every path-like span is lexically normalized LAST, after all
 * substitutions, because the substitutions themselves create the mismatches —
 * a trailing-separator `AFK_HOME` turns `$AFK_HOME/config` into
 * `/relocated//config`. The restricted needles are built with `path.join` /
 * `resolve`, which emit only the normal form, and the final match is a literal
 * `includes()`. Any spelling that is POSIX-equivalent but lexically different
 * therefore fails OPEN unless it is folded to the same normal form here.
 *
 * `path.posix.normalize` (not a bare `//` collapse) is what makes this a CLASS
 * fix: `//`, `/./`, and `/../` all reduce. The distinguishing factor is not
 * which character is used but WHERE it lands — a separator that splits the span
 * the needle covers breaks the match, while the same characters after the
 * needle are harmless. `~/.afk/./config/afk.env` and `~/.afk//config/afk.env`
 * both defeated the default-home floor for exactly this reason; neither is
 * `AFK_HOME`-specific.
 *
 * Braced `${VAR}` is substituted alongside bare `$VAR` because it is the
 * ordinary spelling a non-adversarial model emits, not an evasion — it sits
 * inside this hook's accidental-access threat model, unlike the runtime
 * variable assembly (`H=$HOME; …$H/…`) the module header rules out.
 *
 * Safe for non-path text: the result is used ONLY for substring matching and is
 * never executed, so mangling `https://x` to `https:/x` in this scanned copy
 * cannot affect what runs, and no sensitive root resembles a mangled scheme.
 */
function normalizeHomeRefs(command: string, home: string, afkHome: string | undefined): string {
  const normalized =
    afkHome === undefined ? command : command.replace(/\$\{AFK_HOME\}|\$AFK_HOME\b/g, afkHome);
  return normalized
    .replace(/\$\{HOME\}|\$HOME\b/g, home)
    .replace(/(^|[\s/=:])~(?=$|[/\s])/g, `$1${home}`)
    .replace(PATH_LIKE_SPAN, (span) => path.posix.normalize(span));
}

/**
 * An absolute-path-like run inside a command string: a `/` followed by
 * everything up to the next shell metacharacter, quote, or whitespace.
 *
 * Contract: deliberately greedy on ordinary path characters and deliberately
 * stops at `'"`;|&()<>` and whitespace so one span cannot swallow a following
 * argument and drag unrelated text through `normalize`.
 */
const PATH_LIKE_SPAN = /\/[^\s'"`;|&()<>]*/g;

/** Placeholder left behind by {@link scrubAllowlistedRefs}. Deliberately free of
 * any path characters so it can never itself satisfy a root or signal match. */
const ALLOWLISTED_PLACEHOLDER = '<allowlisted-file>';


/**
 * The exact-file carve-outs (`READ_ALLOWLIST_REL`) in every spelling a bash
 * command can plausibly use, filtered through {@link isReadDenied} so the
 * precedence contract of `AFK_READ_DENYLIST` is reused rather than re-derived:
 * an operator who re-denies `~/.afk/config/mcp.json` there keeps it blocked on
 * the bash surface too.
 *
 * The absolute form covers a normalized `$HOME`/bare-`~` command; the `~/` form
 * covers the quote-prefixed `~` that `normalizeHomeRefs` deliberately leaves
 * alone (`expanduser('~/.afk/config/mcp.json')`). The `$HOME/` form is
 * unreachable while normalization runs first, and is kept as the one spelling
 * that would silently stop being carved out if that order ever changed.
 *
 * The AFK_HOME-relocated forms (the `$AFK_HOME/...` spellings and their
 * resolved absolute twin) live in {@link afkAllowlistFileForms}; this function
 * builds only the home-anchored forms and merges in the AFK-anchored set when
 * AFK_HOME is configured, preserving the original deduped union.
 */
function allowlistedFileForms(home: string, afkHome: string | undefined): string[] {
  const homeForms = READ_ALLOWLIST_REL.flatMap((rel) => {
    if (isReadDenied(path.join(home, rel)).denied) return [];
    return [path.join(home, rel), `~/${rel}`, `$HOME/${rel}`];
  });
  if (afkHome === undefined) return homeForms;

  const afkForms = afkAllowlistFileForms(afkHome);
  return [...new Set([...homeForms, ...afkForms])];
}

/**
 * Blank out references to the read denylist's exact-file carve-outs before
 * either check scans the command.
 *
 * Invariant: EXACT files only — the same rule `isReadDenied` applies to this
 * list. The trailing `(?![\w./\\*?\[\]{}-])` guard is what enforces it: a
 * prefix-extended lookalike (`mcp.json.bak`, `mcp.json/child`) is left in place
 * and therefore still matches its enclosing `~/.afk/config` root. The class
 * also excludes shell glob/brace metacharacters (`*`, `?`, `[`, `]`, `{`, `}`)
 * on purpose: without them, `mcp.json*` satisfied the lookahead, so the whole
 * exact-file span got scrubbed even though the shell expands that glob to
 * siblings (`mcp.json.bak`) the carve-out was never meant to cover — dropping
 * the only text carrying the denied enclosing root. Dropping this guard
 * entirely would turn one readable file into a readable directory.
 *
 * A SECOND lookahead `(?!['"\`][\w./\\*?\[\]{}-])` closes the quote-concatenation
 * bypass (PR #805 P1): shell concatenates `~/.ssh/config".bak"` into
 * `~/.ssh/config.bak`, so a quote character immediately followed by a path
 * character means the quote OPENS a suffix extending the path past the
 * exact-file boundary — the span must NOT be scrubbed, leaving `.ssh`/
 * `.afk/config` visible to the scanner. All three shell quote characters
 * (`"`, `'`, `` ` ``) are covered — single-quote and backtick concatenation
 * are equivalent bypasses. A CLOSING quote (`"~/.ssh/config"` with EOL/space
 * after) is intentionally unaffected: the first lookahead already passes
 * quote chars (they are not in the path-char class), and the second only
 * rejects a quote + path-char. This is what lets a legitimately quoted whole
 * exact reference stay scrubbed (and allowed) while a quote-concatenated
 * sibling/traversal stays blocked. The same hole, prior to this PR, admitted
 * the `mcp.json` carve-out too: `cat ~/.afk/config/mcp.json"/../afk.env"`
 * would have laundered `.afk/config`.
 */
function scrubAllowlistedRefs(text: string, home: string, afkHome: string | undefined): string {
  let out = text;
  for (const form of allowlistedFileForms(home, afkHome)) {
    const exactRef = new RegExp(
      `${escapeRegExp(form)}(?![\\w./\\\\*?\\[\\]{}-])(?!['"\`][\\w./\\\\*?\\[\\]{}-])`,
      'g',
    );
    out = out.replace(exactRef, ALLOWLISTED_PLACEHOLDER);
  }
  return out;
}

/**
 * True when a command references a sensitive location the path-approval policy
 * protects — via either the grant-filtered restricted substrings (literal /
 * `~` / `$HOME` forms, same as check 2) or the lexical credential-fragment
 * signal (which catches interpreter-assembled paths the literal scan misses).
 * Used to scope the interpreter-eval guard (check 1) so it fires only on
 * credential-adjacent one-liners, not on every `-c`/`-e` invocation.
 *
 * `scanned` is the normalized + carve-out-scrubbed command (see the factory).
 * The lexical signal reads that same string rather than the raw command so the
 * exact-file carve-outs apply to both checks; normalization only ever expands
 * `~`/`$HOME` into the home path, which no signal fragment spans.
 *
 * Relocated-AFK_HOME gap: `SENSITIVE_PATH_SIGNAL` has a hardcoded `.afk/config`
 * fragment that covers the default home install (`~/.afk/config`). When
 * `AFK_HOME` is relocated (e.g. `/opt/my-afk`), the config tree becomes
 * `/opt/my-afk/config` — a path that does NOT match `.afk/config`, so the
 * signal returns false. On headless surfaces with `forceInterpreterGuard=1`,
 * `restrictedSubstrings` is always `[]` (no grant manager), making the lexical
 * signal the SOLE protection — which therefore misses the relocated tree. The
 * third check below closes this gap by testing `scanned` against the runtime
 * `relocatedAfkSensitiveRoots()` value whenever AFK_HOME is configured outside
 * the default home directory.
 */
function referencesSensitivePath(scanned: string, restrictedSubstrings: string[]): boolean {
  if (restrictedSubstrings.some((sub) => textMentionsPath(scanned, sub))) return true;
  if (SENSITIVE_PATH_SIGNAL.test(scanned)) return true;
  // Relocated-AFK_HOME gap: when restrictedSubstrings is empty (headless, no
  // grant manager) and the lexical signal misses a relocated config tree, fall
  // back to a direct check against the runtime sensitive roots.
  return relocatedAfkSensitiveRoots().some((root) => textMentionsPath(scanned, root));
}

/**
 * The static sensitive-root set this hook scans for, before grant filtering.
 *
 * Invariant: the credential half of this list is the TYPED-TOOL read denylist
 * (`BUILTIN_READ_DENYLIST`) by reference, never a hand-copied parallel list.
 * The two lists drifted apart once already — `~/.afk/config` (holding `afk.env`
 * API keys), `~/.config/gcloud`, `~/.npmrc`, `~/.docker/config.json`,
 * `~/.git-credentials`, `~/.kube/config` and `/private/etc/master.passwd` were
 * blocked for `read_file`/`grep`/`glob` while `cat` reached them freely — so
 * importing the list is what keeps a future denylist entry from covering only
 * one surface.
 *
 * The extras below stay local because each is deliberately WIDER than what the
 * shared floor can afford to be. A built-in read-denylist entry is permanent —
 * no operator, mode, or fork can lift it — while every root here is
 * grant-filtered, so `/allow-dir <path>` reopens it for a session. That
 * asymmetry is what lets these be blunt:
 *   - `~/Library/Application Support` — whole dir. The shared floor covers only
 *     the per-browser secret trees inside it (`Google/Chrome`, `Firefox`, …),
 *     because flooring the whole vendor directory permanently would blind
 *     `read_file` to every macOS app config living beside them.
 *   - `~/.password-store` — also in the shared floor now; kept here so the
 *     bash root survives independently of that list's scope.
 *   - `~/.config/gh` — whole dir, wider than the denylist's `hosts.yml` file
 *     floor, since a shell can `cat` every sibling token file the CLI writes.
 *
 * Every entry is then passed through {@link withEtcAliases} so an `/etc` root
 * and its `/private/etc` twin are always both present — the lexical scan cannot
 * realpath its way between them the way the typed tools do.
 */
export function builtinBashSensitiveRoots(): readonly string[] {
  const home = homedir();
  return withEtcAliases([
    path.join(home, 'Library', 'Application Support'),
    path.join(home, '.password-store'),
    path.join(home, '.config', 'gh'),
    path.join(home, 'Library', 'LaunchAgents'),
    path.join(home, 'Library', 'LaunchDaemons'),
    '/Library/LaunchAgents',
    '/Library/LaunchDaemons',
    path.join(home, '.config', 'systemd', 'user'),
    ...BUILTIN_READ_DENYLIST,
  ]);
}

/**
 * Operator `AFK_READ_DENYLIST` entries exactly as spelled, to sit alongside the
 * symlink-RESOLVED forms `getReadDenylist()` returns. A shell command normally
 * names the symlink (`~/.afk/config`), not its target, and this scanner is
 * lexical — so both spellings have to be candidates.
 *
 * Invariant: the parse itself is `read-denylist.ts`'s
 * {@link parseReadDenylistEntries}, NOT a local copy. This function used to
 * re-implement it and the two drifted immediately: neither expanded a leading
 * `~`, so the tilde-spelled form the docs recommend resolved to a literal
 * `./~/…` and protected nothing on either surface (PR #734 review, MAJOR 1).
 * Only the post-parse step differs — resolved there, as-spelled here.
 */
function readDenylistExtrasAsSpelled(): string[] {
  return parseReadDenylistEntries(env.AFK_READ_DENYLIST);
}

/**
 * Add the `/etc` ↔ `/private/etc` twin of every candidate that has one.
 *
 * Invariant: this scan is LEXICAL, so a root is only enforced in the spellings
 * present in the candidate list — while the typed tools realpath first and so
 * catch both for free. `/private/etc/master.passwd` was floored for `read_file`
 * yet `cat /etc/master.passwd` (the same file, macOS symlinks `/etc`) sailed
 * through, because the denylist happened to name only the `/private` form
 * (PR #734 review, MAJOR 2). Deriving the twin mechanically closes the class:
 * a future `/etc/...` or `/private/etc/...` entry cannot cover one spelling
 * only. This is also why the hand-written `/private/etc/sudoers` bash-only
 * extra is gone — it is now derived from the denylist's `/etc/sudoers`.
 */
function withEtcAliases(roots: readonly string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    out.push(root);
    if (root.startsWith('/etc/')) out.push(`/private${root}`);
    else if (root.startsWith('/private/etc/')) out.push(root.slice('/private'.length));
  }
  return out;
}

/**
 * Derive a set of sensitive-path substrings to scan bash commands for.
 *
 * Heuristic: we want to block paths the user has NOT explicitly granted that
 * are likely to contain sensitive material. We do NOT want to block every
 * path outside the cwd — that would break `ls /etc`, `which git`, etc.
 *
 * Candidates are {@link builtinBashSensitiveRoots} plus the operator's
 * `AFK_READ_DENYLIST` extras (via `getReadDenylist()`, which also contributes
 * the symlink-resolved spelling of each built-in). Each is included only when
 * the user's resolveBase is NOT already inside it (so a user working in
 * `~/.ssh` doesn't self-block).
 *
 * Invariant: this grant filter is the one deliberate divergence from the typed
 * read denylist, whose floor is unconditional. Bash's gate exists to stop the
 * ACCIDENTAL `cat`, and an explicit `/allow-dir ~/.ssh` is the user saying they
 * want that path in this session; the typed tools stay floored regardless, so
 * the strict boundary is never the one being relaxed here. This is not limited
 * to explicit grants, though: `granted` below also seeds from
 * `grants.resolveBase` (the session's cwd anchor, always implicitly readable —
 * see `dispatcher.ts`), so a candidate whose ancestor IS the session's
 * resolveBase drops out of restriction with no `/allow-dir` call at all — the
 * containment check (`path.relative`) cannot distinguish an implicit
 * resolveBase root from an explicit `readRoots`/`writeRoots` grant.
 */
export function deriveRestrictedSubstrings(grants: {
  resolveBase: string | undefined;
  readRoots: string[];
  writeRoots: string[];
}): string[] {
  const candidates = [
    ...new Set([
      ...builtinBashSensitiveRoots(),
      ...getReadDenylist(),
      ...readDenylistExtrasAsSpelled(),
      ...relocatedAfkSensitiveRoots(),
    ]),
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

  // Invariant: `!rel.startsWith('..')` alone is NOT a sufficient coverage test
  // on Windows. When `g` and `c` sit on different drives, `path.win32.relative`
  // returns a DRIVE-QUALIFIED ABSOLUTE string (`C:\Users\me\.ssh`) rather than a
  // `..\`-prefixed one, which the bare check reads as "g covers c" and drops the
  // candidate — so a single cross-drive grant (`readRoots: ['D:\\scratch']`)
  // silently emptied the ENTIRE credential floor. `!path.isAbsolute(rel)` is the
  // same guard `computeContainment` carries for this exact class (see
  // handlers/_cwd-utils.ts), and it makes this predicate byte-identical to
  // `ungatedSensitiveRoot`'s (subagent/root-validation.ts) — that identity is
  // what the #852 lockstep property rests on, so the two must not drift again.
  // No-op on POSIX: relative() between two absolute paths is never absolute.
  return candidates.filter((c) => {
    for (const g of granted) {
      const rel = path.relative(g, c);
      if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return false;
    }
    return true;
  });
}
