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
 *    a grant manager is wired (every production provider wires itself, so in
 *    practice this is every dispatcher-originated call), block with redirect
 *    guidance. This is deliberately NARROW:
 *    pure-computation one-liners (`python -c 'print(2**64)'`, `node -e
 *    'console.log(1)'`) are NOT blocked — they touch no sensitive path, so the
 *    block was pure friction with no safety value. The guard exists to close
 *    the one thing check 2's literal-substring scan cannot see: an interpreter
 *    building a credential path at runtime (`open(expanduser('~/.ssh/id_rsa'))`).
 *    Contexts with no grant manager at all (non-dispatcher callers, tests)
 *    fail OPEN by default; opt back in with AFK_FORCE_BASH_INTERPRETER_GUARD=1,
 *    or lift it entirely with AFK_DISABLE_BASH_INTERPRETER_GUARD=1. The
 *    `nonInteractive` signal (below) deliberately does NOT gate this check.
 * 3. RESTRICTED-ROOT SUBSTRING GUARD (check 2): if the command contains a
 *    literal substring referencing a restricted root, block. On interactive
 *    surfaces the root set is grant-filtered (so `/allow-dir` can reopen a
 *    path); on headless surfaces the full builtin floor is used with NO grant
 *    filtering (#2302), because no human is present to approve. The block
 *    message on headless does not offer an interactive escape hatch.
 *
 * Headless is `context.nonInteractive === true` (`isHeadlessSession(config)`,
 * threaded by the dispatcher: `afk chat`, every daemon task including pull,
 * and every fork unless it opts back in) OR no grant
 * manager on the context. Grant-manager ABSENCE alone is NOT a usable headless
 * signal in production: both providers inject themselves as the session grant
 * manager on every surface, so keying on absence left the #2302 floor dead.
 *
 * The restricted roots are the typed-tool read denylist (`read-denylist.ts`)
 * plus a few bash-only extras — one shared list, so a credential path floored
 * for `read_file` is floored for `cat` too, and its exact-file carve-outs
 * (`~/.afk/config/mcp.json`) stay readable in interactive bash. Headless bash
 * skips the carve-outs (deny by default), since it cannot tell read from write. See
 * {@link builtinBashSensitiveRoots} for what each half contributes,
 * {@link deriveRestrictedSubstrings} for the interactive (grant-filtered) path,
 * and {@link headlessRestrictedSubstrings} for the headless (unfiltered) floor.
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
import { homeAliasSpellings, restrictedRootSpellings } from './bash-restriction-hook.win32-spellings.js';

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
  /\.ssh\b|\bid_rsa\b|\bid_ed25519\b|\.gnupg\b|\.aws\b|\.config[/\\]gh\b|\.config[/\\]gcloud\b|\.netrc\b|\.password-store\b|\.afk[/\\]config\b|\.npmrc\b|\.docker[/\\]config\.json\b|\.git-credentials\b|\.kube[/\\]config\b|Library[/\\]Application Support\b|[/\\]etc[/\\]shadow\b|[/\\]etc[/\\]sudoers\b|master\.passwd\b|Library[/\\]LaunchAgents\b|Library[/\\]LaunchDaemons\b|\.config[/\\]systemd\b|AppData[/\\]Roaming[/\\]Mozilla\b|AppData[/\\]Roaming[/\\]gcloud\b|AppData[/\\]Roaming[/\\]Docker\b|AppData[/\\]Local[/\\]Google[/\\]Chrome\b|AppData[/\\]Local[/\\]Chromium\b|AppData[/\\]Local[/\\]BraveSoftware\b|AppData[/\\]Local[/\\]Microsoft[/\\]Edge\b/i;

export interface BashRestrictionHookOptions {

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
   * When true, apply the interpreter-eval denylist even on contexts where no
   * grant manager is wired. By default the denylist fires ONLY when a grant
   * manager is wired (every production provider wires itself, so this covers
   * dispatcher-originated calls on every surface); contexts without one fail
   * open. The per-session `nonInteractive` signal does NOT affect this gate.
   * Wired from `AFK_FORCE_BASH_INTERPRETER_GUARD=1`. Overridden by
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

    // Invariant: two DIFFERENT signals, never conflated.
    //   - `grantManagerWired` gates check 1 (interpreter guard) exactly as it
    //     did before #2302. Every production provider injects itself as the
    //     session grant manager (anthropic-direct provider-runtime.ts
    //     `sessionGrantManager: this`; openai-compatible index.ts), so this is
    //     true on daemon / chat / fork dispatches too. Do not swap it for
    //     `!headless`: that would turn the interpreter guard OFF on exactly the
    //     unattended surfaces #2302 hardens.
    //   - `headless` gates check 2's root set and its block message. It is the
    //     explicit per-session `nonInteractive` signal, falling back to grant-
    //     manager absence only for contexts with no grant manager at all.
    //     Grant-manager presence must NOT be read as "interactive": that made
    //     the headless floor unreachable in production (PR #2312 review).
    // Design decision: forks default `isNonInteractive` to true
    // (fork-child-config.ts), so a forked child gets the UNFILTERED floor in
    // bash even when its parent passed it `readRoots` covering a bash-only
    // sensitive root (e.g. a subtree of ~/Library/Application Support). A
    // fork cannot prompt, so it cannot be granted a root mid-run either; the
    // typed tools remain the path for such reads.
    //
    // The grant manager is the dispatcher-injected one (this session's
    // provider), so a forked child's restricted-root view is derived from ITS
    // own grants, not the top-level session's (#435/#514; global ref retired
    // in #528).
    const grantManager = context.grantManager;
    const grantManagerWired = grantManager !== undefined;
    const headless = context.nonInteractive === true || grantManager === undefined;

    // Precompute the sensitive-path view ONCE — both checks below consume it.
    // `scanned` resolves the obvious `~` / `$HOME` shell idioms to the real home
    // dir (NOT a parser — variable-assembled paths are out of scope; see module
    // header), then, on interactive surfaces only, blanks out the read
    // denylist's exact-file carve-outs so a legitimate
    // `cat ~/.afk/config/mcp.json` does not trip the enclosing `~/.afk/config`
    // root. Both checks scan this same string, so the carve-out cannot apply to
    // one and not the other.
    //
    // `restrictedSubstrings` is:
    //   - On interactive surfaces (not headless): the grant-filtered set, so
    //     `/allow-dir <path>` can open a root for a session.
    //   - On headless surfaces (`headless` above): the BUILTIN sensitive roots
    //     with no grant filtering (#2302). This closes the bypass where a prompt-
    //     injected payload on an unattended daemon could write to ~/.afk/config
    //     or read ~/.ssh via plain bash. The write-denylist protects the TYPED
    //     tools unconditionally; this makes the bash surface consistent.
    //     The exact-file READ carve-outs (mcp.json, schedules.json) are NOT
    //     scrubbed on headless: a bash reference cannot be told apart as read
    //     or write, and writing either file plants an MCP server or a cron
    //     task the bypassPermissions daemon runs. Deny by default there; the
    //     typed write denylist floors all of ~/.afk/config the same way.
    const home = homedir();
    const afkHome = configuredAfkHome();
    const normalized = normalizeHomeRefs(command, home, afkHome);
    const scanned = headless ? normalized : scrubAllowlistedRefs(normalized, home, afkHome);
    const restrictedSubstrings =
      grantManager !== undefined && !headless
        ? deriveRestrictedSubstrings(grantManager.getGrants())
        : headlessRestrictedSubstrings();

    // 1. Interpreter-eval guard — hard block, SCOPED to credential-adjacent
    // one-liners.
    //
    // Invariant: the interpreter guard fires ONLY where (a) a grant manager is
    // wired and (b) the eval payload actually references a sensitive path.
    // (a) is `grantManagerWired`, NOT `!headless` — see the signal invariant
    // above; activation is unchanged by #2302 and by the `nonInteractive`
    // signal. (Check 2, by contrast, blocks on headless too since #2302.)
    // (b) `referencesSensitivePath` scopes the block so pure-computation
    // one-liners pass — that scoping is the calibration; see the module header
    // History note. Overrides:
    //   - AFK_DISABLE_BASH_INTERPRETER_GUARD=1 (`disableInterpreterGuard`)
    //     forces it OFF even on interactive surfaces — and wins over force;
    //   - AFK_FORCE_BASH_INTERPRETER_GUARD=1 (`forceInterpreterGuard`) forces
    //     it ON even with no grant manager wired.
    // On headless contexts `restrictedSubstrings` is the unfiltered floor
    // (#2302), so the guard scans the stricter set there.
    const interpreterGuardActive =
      !opts.disableInterpreterGuard &&
      (grantManagerWired || opts.forceInterpreterGuard === true);
    if (
      interpreterGuardActive &&
      INTERPRETER_DENYLIST.test(command) &&
      referencesSensitivePath(scanned, restrictedSubstrings, home)
    ) {
      return {
        decision: 'block',
        reason:
          'Interpreter one-liner (python -c, node -e, sh -c, ...) referencing a sensitive path ' +
          '(SSH keys, cloud credentials, GPG, /etc/shadow, ...) is blocked by the path-approval ' +
          'policy — an interpreter can assemble a path the shell-substring check cannot see. Use ' +
          'the typed file tools (read_file, write_file, edit_file), which support per-call user ' +
          'approval. Only if those tools cannot do the job, ask the user to run the script ' +
          'themselves. To lift this block — e.g. ' +
          'headless automation that legitimately reads such paths — set ' +
          'AFK_DISABLE_BASH_INTERPRETER_GUARD=1, or disable all of path-approval with ' +
          'AFK_DISABLE_PATH_APPROVAL=1.',
      };
    }

    // 2. Restricted-root substring check.
    // The check is intentionally crude: literal `scanned.includes` against
    // every sensitive directory we can derive. False positives (echo "see
    // ~/.ssh/config") block the bash call, which is acceptable for the
    // accidental threat model.
    //
    // On interactive surfaces (not `headless`) the set is grant-filtered —
    // `/allow-dir <path>` can reopen a root for a session. On headless
    // surfaces (afk chat, daemon, forks, threads) we use the builtin floor with no
    // grant filtering (#2302): this closes the prompt-injection bypass where
    // a malicious MCP/web payload on an unattended daemon could read ~/.ssh or
    // write to ~/.afk/config via plain bash while the typed-tool denylist only
    // covers read_file/write_file/edit_file. The block message on headless does
    // not offer an interactive escape hatch, because no human can approve it.
    //
    // Residual risk: string-based heuristics are bypassed by variable
    // assembly, brace expansion, etc. (see module header). For adversarial
    // containment use an OS-level sandbox; this guard closes the accidental /
    // prompt-injection case.
    if (restrictedSubstrings.length === 0) return {};

    for (const sub of restrictedSubstrings) {
      if (mentionsRestrictedRoot(scanned, sub, home)) {
        if (!headless) {
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
        // Headless: no interactive approval path; block unconditionally.
        return {
          decision: 'block',
          reason:
            `Bash command references a restricted path (${sub}) on a headless surface ` +
            '(daemon / afk chat / subagent / thread). Direct shell access to credential and config ' +
            'paths is blocked to prevent prompt-injection bypass of the typed-tool ' +
            'write-denylist. Use the typed file tools (read_file, write_file, edit_file) ' +
            'or run the command interactively where a human can approve it.',
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
  // On Windows, homedir() returns backslash paths (C:\Users\foo). After
  // substituting $HOME / ~ with the home value, the command may contain
  // mixed separators — e.g. `C:\Users\foo/.afk/config/afk.env`. Normalise
  // backslashes to forward slashes BEFORE the path-span normaliser runs so
  // that PATH_LIKE_SPAN can see the resulting absolute path, and the denylist
  // substring comparisons (which use forward-slash needles) can find a match.
  // This is safe: the string is never executed — it is only scanned for
  // substring matches, so rewriting separators cannot affect what runs.
  return normalized
    .replace(/\$\{HOME\}|\$HOME\b/g, home)
    .replace(/(^|[\s/=:])~(?=$|[/\s])/g, `$1${home}`)
    .replace(/\\/g, '/')
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
  const forms = afkHome === undefined ? homeForms : [...homeForms, ...afkAllowlistFileForms(afkHome)];
  // Invariant: a win32 absolute form must be scrubbed in the same
  // forward-slash spellings the restricted roots are matched in (see
  // mentionsRestrictedRoot), or an allowed exact file (`~/.ssh/config`) would
  // stay visible and over-block on Windows. POSIX forms map to themselves.
  return [...new Set(forms.flatMap((form) => restrictedRootSpellings(form, home)))];
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
 * signal returns false. Before #2302, contexts with no grant manager and
 * `forceInterpreterGuard=1` had `restrictedSubstrings === []`, making the
 * lexical signal the SOLE protection; the headless floor now includes the
 * relocated roots too, and the third check below stays as defense in depth. It
 * closes this gap by testing `scanned` against the runtime
 * `relocatedAfkSensitiveRoots()` value whenever AFK_HOME is configured outside
 * the default home directory.
 */
function referencesSensitivePath(
  scanned: string,
  restrictedSubstrings: string[],
  home: string,
): boolean {
  if (restrictedSubstrings.some((sub) => mentionsRestrictedRoot(scanned, sub, home))) return true;
  if (SENSITIVE_PATH_SIGNAL.test(scanned)) return true;
  // Relocated-AFK_HOME gap: when restrictedSubstrings omits the relocated roots
  // (e.g. a grant-filtered interactive set) and the lexical signal misses a
  // relocated config tree, fall back to a direct check against the runtime
  // sensitive roots.
  return relocatedAfkSensitiveRoots().some((root) => mentionsRestrictedRoot(scanned, root, home));
}

/**
 * Whether the normalized command mentions `root` in any of its lexical
 * spellings.
 *
 * Invariant: `scanned` is forward-slash only (see {@link normalizeHomeRefs}),
 * so a win32 root has to be compared in forward-slash form too, plus its
 * Git Bash `/c/...` twin and both home-prefix spellings. Comparing the raw
 * backslash root is what made the whole bash credential floor fail OPEN on
 * Windows (#703). On POSIX `restrictedRootSpellings` returns `[root]`, so this
 * is exactly the previous `textMentionsPath(scanned, root)`.
 */
function mentionsRestrictedRoot(scanned: string, root: string, home: string): boolean {
  const folded = scanned.toLowerCase();
  // Invariant: the folded prefilter cannot change the verdict — textMentionsPath
  // is true only when the folded strings overlap — it only skips the statSync
  // case probe for spellings that cannot match (same ordering as #2543).
  return restrictedRootSpellings(root, home).some(
    (spelling) => folded.includes(spelling.toLowerCase()) && textMentionsPath(scanned, spelling),
  );
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
    path.join(home, '.config', 'systemd'),
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
 * the strict boundary is never the one being relaxed here.
 *
 * Decision (Option A, #740): `resolveBase` containment CAN drop a builtin
 * credential root from the bash restriction list, with no `/allow-dir` call
 * required. `granted` below also seeds from `grants.resolveBase` (the
 * session's cwd anchor, always implicitly readable — see `dispatcher.ts`), so
 * a candidate whose ancestor IS the session's resolveBase drops out of
 * restriction with no `/allow-dir` call at all — the containment check
 * (`path.relative`) cannot distinguish an implicit resolveBase root from an
 * explicit `readRoots`/`writeRoots` grant. This is intentional:
 *   1. The bash gate is advisory, not a sandbox (see module header threat
 *      model). Stopping an implicit resolveBase drop would not raise the actual
 *      security bar.
 *   2. The typed file tools (read_file, grep, glob) are unconditionally floored
 *      regardless of any grant — the hard boundary is never the one being
 *      relaxed here. Only the shell surface is in scope.
 *   3. #579 already reports the floors as too broad. Option B (exempt builtins
 *      from resolveBase drops) would widen them on the bash surface, making
 *      a user working inside a credential dir (e.g. ~/.ssh) self-block.
 *   4. The sharpest edge — `resolveBase = $HOME` via a permissive `cwd` arg —
 *      is being closed separately via cwd input validation in
 *      `subagent/input-parse.ts`, which rejects home-breadth `cwd` values.
 * Changing this to Option B means splitting `candidates` by provenance and
 * filtering `BUILTIN_READ_DENYLIST`-derived entries against `readRoots`/
 * `writeRoots` only — which would reintroduce the ergonomic footgun the
 * resolveBase seeding was added to prevent.
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
  //
  // Invariant: on win32 a candidate is tested in each of its home-alias
  // spellings (raw `homedir()` vs its realpath, which differ under an 8.3
  // USERPROFILE) because the read denylist keys its roots to the realpath form
  // while grants arrive in whatever spelling the caller used. Both spellings
  // name ONE directory, so this never lifts anything a grant did not cover.
  // It stays inside ungatedSensitiveRoot's lockstep: that guard already checks
  // a grant's lexical AND realpath form against the unfiltered candidates.
  // POSIX: homeAliasSpellings(c) is [c], so this is the prior predicate.
  const home = homedir();
  return candidates.filter((c) => {
    for (const g of granted) {
      for (const form of homeAliasSpellings(c, home)) {
        const rel = path.relative(g, form);
        if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return false;
      }
    }
    return true;
  });
}

/**
 * The restricted-path floor used on **headless surfaces** (#2302): any bash
 * PreToolUse context with `nonInteractive === true` (every daemon task,
 * `afk chat`, forks unless they opt back in) or with no grant manager at all.
 * A wired grant manager does NOT make a context interactive: every production
 * provider wires itself, so the explicit `nonInteractive` signal is what makes
 * this floor reachable in production (PR #2312 review).
 *
 * On interactive surfaces {@link deriveRestrictedSubstrings} grant-filters the
 * same builtin list, so an explicit `/allow-dir` can open a root for a session.
 * On headless surfaces no human is present to approve, so there is no grant
 * filter — the full builtin set is used unconditionally.
 *
 * This closes the bypass described in #2302: before this change, check 2 was
 * either fail-open (no grant manager) or grant-filtered, and the grant filter
 * seeds from `resolveBase` — so a session anchored at `$HOME` dropped every
 * home-dir credential root and `~/.afk/config`, allowing
 * prompt-injected payloads on unattended daemon sessions to execute
 * `echo AFK_SYSTEM_PROMPT=... >> ~/.afk/config/afk.env` or
 * `cat ~/.afk/config/afk.env` freely via bash, bypassing the typed-tool
 * write-denylist that only covers `write_file` / `edit_file`.
 *
 * Limitation: string-based heuristics are bypassed by variable assembly,
 * brace expansion, and interpreter-assembled paths (see module header threat
 * model). This guard raises the bar for the prompt-injection / accidental-
 * access class; it is not a sandbox. For adversarial containment run
 * agent-afk inside an OS-level sandbox (macOS `sandbox-exec`, Linux Landlock /
 * bubblewrap, Docker with dropped capabilities).
 *
 * The exact-file READ carve-outs (`~/.afk/config/mcp.json`,
 * `~/.afk/config/schedules.json`, ...) are NOT blanked on headless surfaces:
 * the factory skips {@link scrubAllowlistedRefs} there, because bash cannot
 * distinguish a read from a write and `echo x > ~/.afk/config/mcp.json` would
 * plant an MCP server. Those files are therefore blocked in headless bash.
 */
function headlessRestrictedSubstrings(): string[] {
  return [
    ...new Set([
      ...builtinBashSensitiveRoots(),
      ...getReadDenylist(),
      ...readDenylistExtrasAsSpelled(),
      ...relocatedAfkSensitiveRoots(),
    ]),
  ];
}
