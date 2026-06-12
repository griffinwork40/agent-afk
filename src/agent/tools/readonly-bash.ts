/**
 * Read-only bash command classifier.
 *
 * Contract: `classifyBashCommand(command)` returns `{ mutating, reason? }`.
 * It is a BEST-EFFORT, default-ALLOW defense-in-depth layer — NOT a security
 * boundary. Three layers enforce a read-only skill's no-mutation constraint:
 *   1. The RECON tool allowlist (nesting.ts) strips `write_file` / `edit_file`
 *      from the forked child entirely, so file mutation via those tools is
 *      structurally impossible.
 *   2. This classifier blocks the well-known MUTATING bash invocations while
 *      letting general read-only recon through (the read-only skill genuinely
 *      needs `git status/log/diff`, `ls`, `cat`, `find`, `grep`, etc.).
 *   3. The SKILL.md prose tells the model the constraint up front.
 *
 * Because bash is a Turing-complete escape hatch, no allowlist or denylist can
 * be exhaustive — a determined model could craft an obfuscated mutation this
 * misses (e.g. `eval "$(printf ...)"`). The goal is to catch the obvious,
 * high-frequency mutation forms that an otherwise well-behaved recon agent
 * would reach for (the `ground-state` surveyor that made 27 bash calls), not
 * to sandbox a hostile process. The default is ALLOW so recon is never broken;
 * we add to the denylist only known mutations sourced from ground-state's own
 * SKILL.md prose.
 *
 * Classification runs in three passes (see `classifyBashCommand`):
 *   - Pass 1 (RAW_RULES): rules that must see the FULL command string —
 *     flag-bearing git/gh/curl/pkg forms. Pass 1b then captures an interpreter
 *     (`python -c`/`node -e`) quoted payload and tests it for a write API.
 *   - Pass 2 (STRIPPED_RULES): rules matching short generic tokens (`cp`, `mv`,
 *     `find … -delete`, command-position `patch`/`install`) run against a
 *     DATA-string-stripped view, so a quoted search term like `grep -rn "cp " .`
 *     is not misread as a `cp` invocation. Command substitutions (`$(…)`,
 *     backticks) are PRESERVED so a real `echo "$(rm -rf x)"` is still caught.
 *   - Pass 3 (redirect): after stripping the allowed no-op sinks, a surviving
 *     `>`/`>>` operator is a write to a real path.
 *
 * Invariant: never strip a command substitution while quote-stripping — doing
 * so would hide a real mutation. `stripDataStrings` only removes single-quoted
 * runs (never expanded by bash) and double-quoted runs that contain no `$(`
 * and no backtick.
 *
 * @module agent/tools/readonly-bash
 */

/**
 * Denylist of mutating command patterns, each with a human-readable reason.
 * All regexes are case-insensitive and anchored on word boundaries where a bare
 * verb could otherwise match a substring (e.g. `git committee`).
 */
interface MutationRule {
  readonly re: RegExp;
  readonly reason: string;
}

// ── git mutations ──────────────────────────────────────────────────────────
// Subcommands that write the repo, index, refs, or remote. `git config` is
// handled separately (its read forms must be allowed). `git stash` is allowed
// only in its read forms (`stash list` / `stash show`).
const GIT_MUTATING_VERBS =
  /\bgit\b[^|;&]*\s(commit|push|pull|merge|rebase|reset|checkout|switch|restore|cherry-pick|revert|am|apply|clean|add|rm|mv|init)\b/i;
// `git tag -<flag>` (create/delete/force) mutates; bare `git tag` (list) is fine.
const GIT_TAG_MUTATING = /\bgit\b[^|;&]*\s+tag\s+-/i;
// `git branch -d/-D/-m/-M` (delete/move); bare `git branch` (list) is fine.
const GIT_BRANCH_MUTATING = /\bgit\b[^|;&]*\s+branch\s+-[dDmM]\b/i;
// `git remote add|remove|rm|set-url|rename`; bare `git remote [-v]` (list) is fine.
const GIT_REMOTE_MUTATING = /\bgit\b[^|;&]*\s+remote\s+(add|remove|rm|set-url|rename)\b/i;
// `git worktree remove|prune|move|lock|unlock` mutates the worktree list / filesystem.
// Bare `git worktree list` is read-only and is intentionally not matched.
const GIT_WORKTREE_MUTATING =
  /\bgit\b[^|;&]*\s+worktree\s+(remove|prune|move|lock|unlock)\b/i;
// `git stash` in any form EXCEPT the read-only `stash list` / `stash show`.
// A bare `git stash` (implicit push) mutates, so it must be blocked too.
// Invariant: `classifyBashCommand` strips `stash@{N}` reflog refs (see
// STASH_REFLOG_REF) BEFORE this rule runs. Without that, the greedy `[^|;&]*`
// backtracks onto the literal `stash` inside the argument `stash@{0}`, where the
// negative lookahead sees `@` (not `list`/`show`) and fires — misclassifying the
// read `git stash show stash@{0}` as a mutation.
const GIT_STASH_MUTATING = /\bgit\b[^|;&]*\s+stash\b(?!\s+(list|show)\b)/i;
// A git reflog reference (`stash@{0}`, `stash@{2 days ago}`). Always an ARGUMENT,
// never a command verb — stripping it before classification cannot hide a
// mutation (the real subcommand verb is left in place) and prevents the
// GIT_STASH_MUTATING backtracking false-positive described above.
const STASH_REFLOG_REF = /\bstash@\{[^}]*\}/gi;
// `git config` WRITES take two forms, both blocked:
//   1. an explicit write/unset/edit flag (`--add`, `--unset`, `--edit`, …); or
//   2. a `[scope] <key> <value>` set form — a config key followed by a value
//      token (`git config user.name "Foo"`, `git config --global user.email x`).
// Every READ form must pass: a bare key read (`git config user.name`),
// `--get*`/`--list`/`-l`, with or without an intervening `--global`/`--local`/
// `--system`/`--worktree`/`--file <f>` scope flag. The previous single rule
// over-blocked `git config --global --get …` and bare key reads because its
// negative lookahead only suppressed when a read flag IMMEDIATELY followed
// `config`; an intervening scope flag defeated it.
const GIT_CONFIG_WRITE_FLAG =
  /\bgit\s+config\b[^|;&]*\s(--add|--unset|--unset-all|--replace-all|--rename-section|--remove-section|--edit|-e)\b/i;
const GIT_CONFIG_SET =
  /\bgit\s+config\s+(?:--(?:global|system|local|worktree)\s+|(?:--file|-f)\s+\S+\s+)*[\w][\w.-]*\s+\S/i;

// ── gh (GitHub CLI) mutations ──────────────────────────────────────────────
// `gh <noun> <mutating-verb>` — covers pr/issue/repo/release/etc. create,
// merge, close, edit, delete, comment, review, reopen, sync, fork, clone, ready.
const GH_NOUN_MUTATING =
  /\bgh\s+\w[\w-]*\s+(create|merge|close|edit|delete|comment|review|reopen|sync|fork|clone|ready)\b/i;
// `gh api` with a write method or field payload mutates the remote.
const GH_API_WRITE_METHOD =
  /\bgh\s+api\b.*(-X|--method)\s+(POST|PUT|PATCH|DELETE)\b/i;
const GH_API_FIELD = /\bgh\s+api\b.*(\s-f\b|\s-F\b|--field\b)/i;
// `gh secret/variable/workflow/run/cache/ssh-key/gpg-key <mutating-verb>` — extended
// write subcommands not covered by the generic GH_NOUN_MUTATING pattern above.
const GH_EXTENDED_MUTATING =
  /\bgh\s+(secret|variable|workflow|release|run|cache|ssh-key|gpg-key)\s+(set|run|rerun|cancel|upload|delete|enable|disable)\b/i;

// ── pipe-to-shell ──────────────────────────────────────────────────────────
// `curl … | bash`, `cat install.sh | sh`, etc. — any pipe whose right-hand side
// is a shell interpreter is arbitrary remote code execution. Evaluated in
// STRIPPED_RULES (Pass 2), NOT against the raw command: a REAL pipe-to-shell
// operator is never inside quotes (quoting `| bash` makes it a literal string,
// not a pipe), so running against the data-string-stripped view drops false
// positives such as `grep -rn '| bash' src/` (a recon search for the literal
// text) while still catching every genuine pipeline — which by definition
// survives stripping. The `sh -c "…| bash"` obfuscation form (a quoted payload
// handed to an interpreter) is intentionally out of scope per the module's
// stated threat model (well-behaved recon agent, not a hostile process).
const PIPE_TO_SHELL = /\|\s*(sh|bash|zsh|dash)\b/i;

// ── filesystem mutations ───────────────────────────────────────────────────
// Bare destructive/creative filesystem verbs. Word-boundary anchored so we
// match the command verb, not a substring (`removed`, `cpio`, etc. are safe).
// Run against the DATA-string-stripped view (Pass 2) so a quoted search term
// like `grep -rn "cp " .` or `grep -rn "tee " .` is NOT misread as a mutation.
const FS_MUTATING =
  /\b(rm|rmdir|unlink|mv|cp|mkdir|touch|dd|truncate|tee|sponge|ln|chmod|chown|chgrp|shred|rsync)\b/i;
// `find … -delete` removes matched files. `-delete` is distinctive, so match it
// anywhere within the `find` command segment.
const FIND_DELETE = /\bfind\b[^|;&]*\s-delete\b/i;
// `find … -exec <mutating-verb>` — the verb may be quoted (Pass 2 strips quotes,
// so this must live in Pass 1 / RAW_RULES to see the original).
const FIND_EXEC_MUTATING =
  /\bfind\b[^|;&]*\s-exec\s+['"]?\s*(rm|rmdir|unlink|mv|cp|dd|truncate|shred|tee|chmod|chown|chgrp|install|patch)\b/i;
// `install` (coreutils) and `patch` mutate the filesystem, but both names also
// appear as plain filenames/args during recon (`cat install.log`,
// `less patch.txt`). Match them ONLY in COMMAND POSITION — at the start of the
// line or a pipeline/chaining segment — to avoid those false-positives.
const CMD_START = String.raw`(?:^|[\n;|&(]|\$\()\s*`;
const PATCH_CMD = new RegExp(CMD_START + String.raw`patch\b`, 'i');
const INSTALL_CMD = new RegExp(CMD_START + String.raw`install\b`, 'i');
// `source` / `. <script>` execute the named file in the current shell, producing
// arbitrary side effects. CMD_START-anchored so a filepath containing `source`
// isn't matched.
const SOURCE_CMD = new RegExp(CMD_START + String.raw`(?:source\b|\.\s+\S)`, 'i');

// ── archive extraction / creation / append / update ───────────────────────
// Archive creation (c), extraction (x), append (r), update (u), and
// concatenate-archives (A) all write files or modify an archive on disk.
// List mode (t) is read-only and intentionally not matched.
// These run in STRIPPED_RULES so a quoted grep search term like
// `grep "tar czf"` isn't misread as a real invocation.
// The regex anchors to the first token immediately after `tar` — no skip-ahead —
// to avoid false-positives on archive filenames that contain mode-flag letters
// (e.g. `tar tf a.tar` would match `a` via the skip-ahead form with /i).
const TAR_WRITE = /\btar\s+-?[a-zA-Z]*[cxruA][a-zA-Z]*\b/i;
// `unzip` in command position.
const UNZIP_CMD = new RegExp(CMD_START + String.raw`unzip\b`, 'i');
// `cpio -i` (copy-in / extract) writes files; `cpio -o`/`-p` (copy-out / pass)
// are read-only and intentionally not matched.
const CPIO_EXTRACT = /\bcpio\b[^|;&]*\s-[a-zA-Z]*i\b/i;

// ── in-place edits ─────────────────────────────────────────────────────────
// `sed -i ...` and `perl -i` / `perl -<flags>i` edit files in place.
const SED_INPLACE = /\bsed\b[^|;&]*\s-[a-zA-Z]*i\b/i;
const PERL_INPLACE = /\bperl\b[^|;&]*\s-[a-zA-Z]*i\b/i;

// ── interpreter one-liner writes ───────────────────────────────────────────
// `python -c`, `node -e`, `ruby -e`, etc. can write files from inside the
// quoted payload, bypassing the FS verb rules. INTERPRETER_EVAL captures the
// QUOTED payload that follows the `-c`/`-e` flag; INTERPRETER_WRITE_API is then
// tested against that captured string only (see `classifyBashCommand`).
//
// Invariant: test the write API against the CAPTURED PAYLOAD, never the whole
// line. Capturing the entire quoted string (a) handles a `;`-separated
// multi-statement payload (`python -c "import io; io.open('x','w')..."`), and
// (b) keeps a write token in a LATER pipeline segment from being misattributed
// (`python -c "open('f').read()" && grep writeFileSync src` is a READ + a grep,
// not a write). The lazy `[^|;&]*?` before the flag keeps the `-c`/`-e` itself
// within the interpreter's own segment. Reads such as `open('f').read()` (no
// write mode) are intentionally NOT matched.
const INTERPRETER_EVAL =
  /\b(?:python3?|nodejs|node|bun|ruby|perl|php)\b[^|;&]*?\s-(?:c|e)\b\s*("(?:[^"\\]|\\.)*"|'[^']*'|`[^`]*`)/i;
const INTERPRETER_WRITE_API =
  /open\s*\([^)]*,\s*['"][wax]|writeFileSync|writeFile\b|appendFileSync|appendFile\b|createWriteStream|File\.(?:write|delete)\b|IO\.write\b|FileUtils\.|\bBun\.write\b|os\.remove\b|shutil\.\w|\.write_text\b|\.write_bytes\b/i;

// ── package installs ───────────────────────────────────────────────────────
// Package managers performing install/modify operations on the dependency tree.
const PKG_INSTALL =
  /\b(npm|pnpm|yarn|pip|pip3|brew|cargo|go|apt|apt-get|gem|poetry|bundle|composer)\s+(install|add|remove|uninstall|i|ci|up|update|upgrade|dlx|get|require)\b/i;

// ── curl / wget writes ─────────────────────────────────────────────────────
// Download-to-file (`-o`/`-O`/`--output`) or write HTTP methods / form data.
const CURL_WGET_OUTPUT = /\b(curl|wget)\b[^|;&]*\s(-o\b|-O\b|--output\b)/i;
const CURL_WRITE_METHOD = /\bcurl\b[^|;&]*\s-X\s+(POST|PUT|PATCH|DELETE)\b/i;
const CURL_DATA = /\bcurl\b[^|;&]*\s(-d\b|--data\b|-F\b|--form\b)/i;

// ── output redirection to a real path ──────────────────────────────────────
// `>` / `>>` that targets a real path mutates the filesystem. We ALLOW the
// common no-op sinks: `>/dev/null`, `2>/dev/null`, `&>/dev/null`, `2>&1`,
// `>&2`, `>&1`. Strategy: strip the allowed redirection forms first, then look
// for any remaining `>`/`>>` redirection operator.
const ALLOWED_REDIRECTS =
  /(\d*&?>>?\s*\/dev\/null|\d*>&\d+|&>\s*\/dev\/null|&>>\s*\/dev\/null)/gi;
// Arithmetic expansion `$(( … ))` can contain a `>`/`<` COMPARISON that is not
// a redirect. Strip it from the redirect view before scanning.
const ARITHMETIC_EXPANSION = /\$\(\(.*?\)\)/g;
// After stripping allowed redirects, a surviving redirection operator is a
// write to a real path. Match `>`/`>>` UNLESS the preceding char makes it part
// of `=>`, `->`, `<>`, `>>` (second `>`), or an arithmetic comparison — i.e.
// exclude `[=<>-]` immediately before, and forbid a following `&`.
// Note: `&` is intentionally NOT in the lookbehind. `&>/dev/null` is already
// removed by ALLOWED_REDIRECTS above; any surviving `&>` targeting a real path
// is rewritten to `>` before this check (see `redirectView` construction below),
// so keeping `&` in the lookbehind would create a blind spot.
// Unlike the old whitespace-anchored form, this also catches token-adjacent
// redirects (`echo x>file`) while keeping arrow/comparison tokens (`=>`, `->`)
// — high-frequency in TS/Rust recon — allowed.
const REAL_REDIRECT = /(?<![=<>-])>>?(?!&)/;

// Rules evaluated against the RAW command string (Pass 1). These must see the
// full command (flag positions, chaining). Interpreter payload writes are
// handled separately in Pass 1b; see INTERPRETER_EVAL.
const RAW_RULES: readonly MutationRule[] = [
  { re: GIT_MUTATING_VERBS, reason: 'git repository mutation' },
  { re: GIT_TAG_MUTATING, reason: 'git tag create/delete' },
  { re: GIT_BRANCH_MUTATING, reason: 'git branch delete/rename' },
  { re: GIT_REMOTE_MUTATING, reason: 'git remote mutation' },
  { re: GIT_STASH_MUTATING, reason: 'git stash mutation (only `stash list`/`stash show` allowed)' },
  { re: GIT_CONFIG_WRITE_FLAG, reason: 'git config write flag (only reads allowed)' },
  { re: GIT_CONFIG_SET, reason: 'git config set (`<key> <value>`; only reads allowed)' },
  { re: GH_NOUN_MUTATING, reason: 'gh write operation' },
  { re: GH_API_WRITE_METHOD, reason: 'gh api write method (POST/PUT/PATCH/DELETE)' },
  { re: GH_API_FIELD, reason: 'gh api field payload (-f/-F/--field)' },
  { re: GH_EXTENDED_MUTATING, reason: 'gh extended write operation (secret/variable/workflow/run/cache)' },
  { re: GIT_WORKTREE_MUTATING, reason: 'git worktree mutation (remove/prune/move)' },
  { re: SED_INPLACE, reason: 'sed in-place edit (-i)' },
  { re: PERL_INPLACE, reason: 'perl in-place edit (-i)' },
  { re: PKG_INSTALL, reason: 'package install/modify' },
  { re: CURL_WGET_OUTPUT, reason: 'curl/wget output-to-file' },
  { re: CURL_WRITE_METHOD, reason: 'curl write method (POST/PUT/PATCH/DELETE)' },
  { re: CURL_DATA, reason: 'curl data/form payload' },
  { re: FIND_EXEC_MUTATING, reason: 'find -exec with mutating verb' },
];

// Rules evaluated against the DATA-string-stripped view (Pass 2). These match
// short generic tokens that recur as quoted search terms / arguments, so they
// must not see the contents of plain string literals.
const STRIPPED_RULES: readonly MutationRule[] = [
  { re: PIPE_TO_SHELL, reason: 'pipe-to-shell (RCE via piped interpreter)' },
  { re: FS_MUTATING, reason: 'filesystem mutation' },
  { re: FIND_DELETE, reason: 'find -delete (file removal)' },
  { re: PATCH_CMD, reason: 'patch (applies a diff to files)' },
  { re: INSTALL_CMD, reason: 'install (writes files)' },
  { re: SOURCE_CMD, reason: 'source/dot-source executes a script' },
  { re: TAR_WRITE, reason: 'tar create/extract/append/update (writes files/archive)' },
  { re: UNZIP_CMD, reason: 'unzip (writes files)' },
  { re: CPIO_EXTRACT, reason: 'cpio extract (-i mode writes files)' },
];

/**
 * Remove DATA string literals from a command so generic tokens used as search
 * terms / arguments (`cp`, `mv`, `>`, …) are not misread as commands.
 *
 * Contract: single-quoted runs never expand in bash, so they are always data —
 * strip them wholesale. Double-quoted runs are stripped ONLY when they contain
 * no command substitution (`$(`) and no backtick; otherwise a real command such
 * as `echo "$(rm -rf x)"` would be hidden, producing a false-negative. Bare
 * `$VAR` expansion inside double quotes is data and safe to strip.
 */
function stripDataStrings(command: string): string {
  return command
    .replace(/'[^']*'/g, ' ')
    .replace(/"(?:[^"\\]|\\.)*"/g, (match) => (/\$\(|`/.test(match) ? match : ' '));
}

/**
 * Classify a bash command string as mutating or read-only.
 *
 * Returns `{ mutating: false }` for anything not matched by the denylist
 * (default-ALLOW). Returns `{ mutating: true, reason }` when any clause of the
 * command matches a known mutation form. The `reason` is a short, stable label
 * suitable for surfacing in a blocked-tool error message.
 */
export function classifyBashCommand(command: string): { mutating: boolean; reason?: string } {
  if (typeof command !== 'string' || command.trim().length === 0) {
    // Empty / non-string commands do nothing — not a mutation.
    return { mutating: false };
  }

  // Pass 1 — rules that must see the FULL command (flag-bearing gh/curl/git/pkg
  // forms). First neutralize `stash@{N}` reflog refs → ` `: they are arguments,
  // never verbs, and the literal `stash` inside them otherwise lets
  // GIT_STASH_MUTATING's greedy prefix backtrack onto the argument and misclassify
  // the read `git stash show stash@{0}` as a mutation. Stripping the ref cannot
  // hide a mutation — the real subcommand verb (`drop`/`pop`/`apply`/…) remains.
  const rawForRules = command.replace(STASH_REFLOG_REF, ' ');
  for (const rule of RAW_RULES) {
    if (rule.re.test(rawForRules)) {
      return { mutating: true, reason: rule.reason };
    }
  }

  // Pass 1b — interpreter one-liner writes: capture the quoted `-c`/`-e` payload
  // and test it (and only it) for a write API.
  const interpreterPayload = command.match(INTERPRETER_EVAL)?.[1];
  if (interpreterPayload && INTERPRETER_WRITE_API.test(interpreterPayload)) {
    return { mutating: true, reason: 'interpreter one-liner file write (`-c`/`-e`)' };
  }

  // Pass 2 — rules matching short generic tokens, evaluated against a view with
  // DATA string literals removed so a quoted search term isn't misread.
  const unquoted = stripDataStrings(command);
  for (const rule of STRIPPED_RULES) {
    if (rule.re.test(unquoted)) {
      return { mutating: true, reason: rule.reason };
    }
  }

  // Pass 3 — output redirection. Strip the allowed no-op sinks and arithmetic
  // comparisons from the stripped view, then look for a surviving `>`/`>>`
  // write to a real path.
  // Step 1: strip arithmetic expansions and allowed sinks (`>/dev/null`, `2>&1`, etc.).
  // Step 2: rewrite any surviving `&>>?` that targets a real path (i.e. NOT
  //   `/dev/null`) to a plain `>>`/`>` so REAL_REDIRECT can catch it.  The
  //   ALLOWED_REDIRECTS pass above already removed `&>/dev/null` / `&>>/dev/null`,
  //   so anything still bearing `&>` here is a write to a real file.
  const redirectView = unquoted
    .replace(ARITHMETIC_EXPANSION, ' ')
    .replace(ALLOWED_REDIRECTS, ' ')
    .replace(/&(>>?)/g, '$1');  // normalize &> realfile → > realfile (ALLOWED_REDIRECTS already removed &>/dev/null)
  if (REAL_REDIRECT.test(redirectView)) {
    return { mutating: true, reason: 'output redirection to a file (`>`/`>>`)' };
  }

  return { mutating: false };
}
