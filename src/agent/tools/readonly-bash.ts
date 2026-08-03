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
 * Classification runs in four passes (see `classifyBashCommand`):
 *   - Pass 1 (RAW_RULES): the ONLY rules that must see the raw string are the
 *     ones whose mutation SIGNAL can itself be legitimately quoted — `git config
 *     <key> <value>` (the value is often quoted) and `find … -exec <verb>` (the
 *     verb may be quoted). Quote-stripping those would hide a real write. Pass 1b
 *     then captures an interpreter (`python -c`/`node -e`) quoted payload and
 *     tests it for a write API.
 *   - Pass 1c (tokenizer, #577): the git repository-mutation and curl-method
 *     rules are matched POSITIONALLY, not by string regex. A small command-line
 *     tokenizer (`tokenizeSegments` → `resolveSegment`) splits the line into
 *     segments, resolves one level of `VAR=val;$VAR` indirection, unwraps no-op
 *     wrappers (`env`/`xargs`/`command`/`sudo`/`busybox`/…), and recurses into
 *     `$(…)`/backtick substitutions, so the verb is judged in SUBCOMMAND
 *     position. This fixes both an over-block (`git log -S push` — `push` is a
 *     pickaxe ARG, not the subcommand) and an under-block (`g=git; $g push`,
 *     `curl -X "POST"` — reached via indirection / a quoted flag value).
 *   - Pass 2 (STRIPPED_RULES): every other rule runs against a DATA-string-
 *     stripped view. A command name/verb/flag is never legitimately quoted in a
 *     real invocation (`rm -rf`, `gh pr create`, `npm install`, `sed -i`), so
 *     stripping quoted data lets a recon search term like `grep -rn "cp " .` or
 *     `rg "gh pr create"` through while a genuine invocation — whose verb
 *     survives stripping — is still caught. Command substitutions (`$(…)`,
 *     backticks) are PRESERVED so a real `echo "$(rm -rf x)"` is still caught.
 *     (History: the git/gh/curl/pkg/sed rules originally lived in Pass 1;
 *     matching them on the raw string over-blocked recon that merely mentioned a
 *     verb inside quotes — e.g. `rg "git push"` — so gh/curl/pkg/sed moved here,
 *     and the git repository-mutation verbs moved to the Pass-1c tokenizer.)
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

// ── git mutations (subcommand-anchored — see `gitSegmentReason` below) ───────
// History: the git repository-mutating subcommands (commit/push/reset/stash/
// tag/branch/remote/worktree/…) were matched by string regexes of the shape
// `/\bgit\b[^|;&]*\s(verb)\b/`. That matched the verb ANYWHERE after `git` in a
// segment, so it (a) over-blocked recon whose ARG collides with a verb
// (`git log -S push`, `git log --grep revert`, `git help push`) and (b) was
// defeated by variable indirection (`g=git; $g push`). Both are now handled
// POSITIONALLY by the command-line tokenizer + `gitSegmentReason` (see below,
// #577): the verb must sit in subcommand position (after `git` and its global
// flags such as `-C dir` / `-c x=y` / `--no-pager`), so bare args no longer
// false-match and wrapped/indirected invocations resolve to command position.
// The `stash@{N}` reflog-ref stripping the old GIT_STASH_MUTATING needed is also
// gone: the tokenizer reads `stash`'s next token (`list`/`show` → read, else
// mutating), so `git stash show stash@{0}` is classified by subcommand, not by
// a greedy prefix backtracking onto the `stash` inside the argument.
// `git config` is still matched by regex (GIT_CONFIG_* below) because its
// mutation signal — a quoted `<value>` — must be read on the raw string.
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
// is a shell OR a scripting interpreter reading stdin is arbitrary code
// execution. Evaluated in STRIPPED_RULES (Pass 2), NOT against the raw command:
// a REAL pipe-to-shell operator is never inside quotes (quoting `| bash` makes
// it a literal string, not a pipe), so running against the data-string-stripped
// view drops false positives such as `grep -rn '| bash' src/` (a recon search
// for the literal text) while still catching every genuine pipeline — which by
// definition survives stripping. The `sh -c "…| bash"` obfuscation form (a
// quoted payload handed to an interpreter) is intentionally out of scope per the
// module's stated threat model (well-behaved recon agent, not a hostile process).
// The alternation is anchored to command position (immediately after `|`), so a
// LATER arg like `ps aux | grep node` (node is grep's arg) does not match.
// (#577 widened `sh|bash|zsh|dash` → the other common shells + the scripting
// interpreters that execute piped stdin: `… | python`, `… | perl`.)
const PIPE_TO_SHELL =
  /\|\s*(sh|bash|zsh|dash|ksh|mksh|csh|tcsh|fish|ash|python3?|node|nodejs|perl|ruby|php|bun)\b/i;

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
// (#577 widened: added `os.system`/`os.popen`/`subprocess` — a `-c`/`-e` payload
// that shells out is a write vector, not a read — plus `Deno.*` write/remove APIs.)
const INTERPRETER_WRITE_API =
  /open\s*\([^)]*,\s*['"][wax]|writeFileSync|writeFile\b|appendFileSync|appendFile\b|createWriteStream|File\.(?:write|delete)\b|IO\.write\b|FileUtils\.|\bBun\.write\b|os\.remove\b|os\.system\b|os\.popen\b|\bsubprocess\.|\bDeno\.(?:write|writeFile|writeTextFile|remove)\b|shutil\.\w|\.write_text\b|\.write_bytes\b/i;

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

// Rules evaluated against the RAW command string (Pass 1). ONLY rules whose
// mutation signal can be legitimately quoted belong here — quote-stripping them
// (as Pass 2 does) would hide a real write:
//   - GIT_CONFIG_SET: the value in `git config <key> <value>` is often quoted
//     (`git config user.name "Foo"`); stripping it leaves the key with no value
//     token, so the set-form would go undetected.
//   - FIND_EXEC_MUTATING: the verb after `-exec` may be quoted (`-exec 'rm'`).
// Every OTHER mutation rule (git verbs, gh, curl, pkg, sed/perl) lives in
// STRIPPED_RULES: its command name/verb/flag is never quoted in a real call, so
// matching it against the raw string only over-blocks recon (`rg "git push"`).
// Interpreter payload writes are handled separately in Pass 1b; see INTERPRETER_EVAL.
const RAW_RULES: readonly MutationRule[] = [
  { re: GIT_CONFIG_SET, reason: 'git config set (`<key> <value>`; only reads allowed)' },
  { re: FIND_EXEC_MUTATING, reason: 'find -exec with mutating verb' },
];

// Rules evaluated against the DATA-string-stripped view (Pass 2). A command
// name/verb/flag is never legitimately quoted in a real invocation, so matching
// the quote-stripped view lets a recon search term like `grep -rn "cp " .` or
// `rg "git push"` through while a genuine invocation (whose verb survives
// stripping) is still caught. These must not see the contents of string literals.
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
  // gh / curl / pkg / sed verb-and-flag rules — in STRIPPED_RULES so a quoted
  // mention (`rg "gh pr create"`, `grep "npm install"`) is not misread as an
  // invocation. A real call's verb/flag is unquoted and survives stripping. The
  // git repository-mutation rules (push/commit/stash/…) are NOT here: they are
  // matched positionally by the tokenizer (`gitSegmentReason`) so subcommand
  // anchoring + wrapper/indirection resolution both hold (#577). `git config`
  // remains regex-matched (its quoted value must be read on the raw string).
  { re: GIT_CONFIG_WRITE_FLAG, reason: 'git config write flag (only reads allowed)' },
  { re: GH_NOUN_MUTATING, reason: 'gh write operation' },
  { re: GH_API_WRITE_METHOD, reason: 'gh api write method (POST/PUT/PATCH/DELETE)' },
  { re: GH_API_FIELD, reason: 'gh api field payload (-f/-F/--field)' },
  { re: GH_EXTENDED_MUTATING, reason: 'gh extended write operation (secret/variable/workflow/run/cache)' },
  { re: SED_INPLACE, reason: 'sed in-place edit (-i)' },
  { re: PERL_INPLACE, reason: 'perl in-place edit (-i)' },
  { re: PKG_INSTALL, reason: 'package install/modify' },
  { re: CURL_WGET_OUTPUT, reason: 'curl/wget output-to-file' },
  { re: CURL_WRITE_METHOD, reason: 'curl write method (POST/PUT/PATCH/DELETE)' },
  { re: CURL_DATA, reason: 'curl data/form payload' },
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

// ── command-line tokenizer: subcommand anchoring + wrapper/indirection (#577) ─
// History: the git repository-mutation and curl-method rules used to match verb
// regexes against the whole (quote-stripped) command string. A string match
// cannot tell a verb in COMMAND position from the same word in an ARGUMENT, so
// it over-blocked recon (`git log -S push`) and under-blocked mutations reached
// via a wrapper (`env`/`xargs`/`command`/`sudo`/`busybox`), a shell variable
// (`g=git; $g push`), or a `$(…)`/backtick substitution. This small lexer splits
// a command into pipeline/chaining segments, resolves ONE level of `VAR=val;$VAR`
// indirection, unwraps no-op wrappers, and recurses into command substitutions,
// so `gitSegmentReason` / `curlSegmentMutating` see the EFFECTIVE command in
// command position and the verb in subcommand position. It is intentionally a
// best-effort tokenizer matching the module's threat model (a well-behaved recon
// agent, not a hostile process) — NOT a full POSIX shell parser.

/** A resolved command segment: the effective command token + its remaining argv. */
interface CmdSegment {
  readonly command: string;
  readonly argv: readonly string[];
}

// Wrappers that run their argument command with the same effect — unwrapping
// them exposes the real verb in command position. Each may carry its own
// flags/assignments before the wrapped command (consumed in `resolveSegment`).
// `eval` is included: `eval git push` runs git push, so the wrapped verb must be
// judged in command position (its quoted-payload form `eval "git push"` remains
// out of scope per the module's threat model, like `sh -c`).
const NOOP_WRAPPERS = new Set([
  'env', 'xargs', 'command', 'sudo', 'nice', 'time', 'timeout', 'nohup', 'stdbuf', 'busybox', 'eval',
]);

/** Command base name: drop a leading path (`/usr/bin/git`) and an escaping backslash (`\git`). */
function baseName(cmd: string): string {
  return (cmd.split('/').pop() ?? cmd).replace(/^\\+/, '');
}

// Wrapper options that consume a SEPARATE operand token (the `--opt=val` attached
// form needs no extra skip). If the operand isn't consumed, it is mistaken for the
// wrapped command and the real verb is missed (`env -u FOO git stash`,
// `xargs --max-args 1 git tag -d`). Kept explicit per `env`/`xargs --help`.
const ENV_OPERAND_OPTS = new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']);
const XARGS_OPERAND_OPTS = new Set([
  '-a', '--arg-file', '-E', '--eof', '-I', '--replace', '-i', '-L', '--max-lines', '-l',
  '-n', '--max-args', '-P', '--max-procs', '-s', '--max-chars', '-d', '--delimiter', '--process-slot-var',
]);

/**
 * Split a command into word-token segments, quote-aware. Single-quoted runs are
 * literal; double-quoted runs are literal EXCEPT `$(…)` / backtick substitutions
 * (which execute, so their inner command is recursed into as its own segment);
 * `; | & ( )` and newlines are segment boundaries. Quote characters are removed
 * but their content preserved, so `curl -X "POST"` → tokens `[curl, -X, POST]`
 * while `grep "curl -X POST"` keeps `curl` as a NON-command-position arg token.
 */
function tokenizeSegments(command: string): string[][] {
  const segments: string[][] = [];
  const subs: string[] = []; // inner text of $(…)/`…` substitutions, recursed at the end
  let seg: string[] = [];
  let tok = '';
  let hasTok = false;
  const endTok = (): void => {
    if (hasTok) {
      seg.push(tok);
      tok = '';
      hasTok = false;
    }
  };
  const endSeg = (): void => {
    endTok();
    if (seg.length > 0) {
      segments.push(seg);
      seg = [];
    }
  };
  const readSubstitution = (start: number): number => {
    // start points just past the opening `(`; return index just past the `)`.
    let j = start;
    let depth = 1;
    let inner = '';
    while (j < command.length && depth > 0) {
      const c = command[j]!;
      if (c === '(') depth++;
      else if (c === ')') {
        depth--;
        if (depth === 0) {
          j++;
          break;
        }
      }
      inner += c;
      j++;
    }
    subs.push(inner);
    return j;
  };
  let i = 0;
  const n = command.length;
  while (i < n) {
    const ch = command[i]!;
    if (ch === "'") {
      hasTok = true;
      i++;
      while (i < n && command[i] !== "'") {
        tok += command[i]!;
        i++;
      }
      i++; // closing quote (or EOL)
      continue;
    }
    if (ch === '"') {
      hasTok = true;
      i++;
      while (i < n && command[i] !== '"') {
        if (command[i] === '$' && command[i + 1] === '(') {
          i = readSubstitution(i + 2);
        } else if (command[i] === '`') {
          i++;
          let inner = '';
          while (i < n && command[i] !== '`') {
            inner += command[i]!;
            i++;
          }
          i++;
          subs.push(inner);
        } else {
          tok += command[i]!;
          i++;
        }
      }
      i++; // closing quote
      continue;
    }
    if (ch === '`') {
      endTok();
      i++;
      let inner = '';
      while (i < n && command[i] !== '`') {
        inner += command[i]!;
        i++;
      }
      i++;
      subs.push(inner);
      continue;
    }
    if (ch === '$' && command[i + 1] === '(') {
      endTok();
      i = readSubstitution(i + 2);
      continue;
    }
    if (ch === ';' || ch === '\n' || ch === '&' || ch === '|' || ch === '(' || ch === ')') {
      endSeg();
      i++;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      endTok();
      i++;
      continue;
    }
    tok += ch;
    hasTok = true;
    i++;
  }
  endSeg();
  for (const s of subs) {
    for (const inner of tokenizeSegments(s)) segments.push(inner);
  }
  return segments;
}

/**
 * Resolve a raw token segment into its effective command: capture leading
 * `VAR=val` assignments into `vars` (visible to later segments — `g=git; $g …`),
 * substitute a one-level `$VAR` command token, and unwrap no-op wrappers. Returns
 * null for a pure-assignment / empty segment.
 */
function resolveSegment(rawTokens: readonly string[], vars: Map<string, string>): CmdSegment | null {
  let tokens = [...rawTokens];
  let idx = 0;
  const kw = tokens[idx];
  if (kw === 'export' || kw === 'local' || kw === 'declare') idx++;
  while (idx < tokens.length) {
    const m = /^([A-Za-z_]\w*)=(.*)$/.exec(tokens[idx]!);
    if (m === null) break;
    vars.set(m[1]!, m[2]!);
    idx++;
  }
  for (let guard = 0; idx < tokens.length && guard < 12; guard++) {
    const cur = tokens[idx]!;
    const vm = /^\$\{?([A-Za-z_]\w*)\}?$/.exec(cur);
    if (vm !== null) {
      const val = vars.get(vm[1]!);
      if (val !== undefined) {
        const parts = val.split(/\s+/).filter(Boolean);
        tokens = [...tokens.slice(0, idx), ...parts, ...tokens.slice(idx + 1)];
        continue; // re-evaluate the now-resolved command token
      }
    }
    const base = baseName(cur);
    if (!NOOP_WRAPPERS.has(base)) break;
    idx++; // consume the wrapper token
    // Consume the wrapper's own flags/assignments so the NEXT token is the command.
    if (base === 'env') {
      // `env` may set VAR=val before the command — record them so a later `$VAR`
      // command token resolves (`env g=git $g push`) — and consume its flags,
      // including operand-taking ones (`env -u FOO git …`, `env -C /dir git …`).
      while (idx < tokens.length) {
        const t = tokens[idx]!;
        const am = /^([A-Za-z_]\w*)=(.*)$/.exec(t);
        if (am !== null) {
          vars.set(am[1]!, am[2]!);
          idx++;
          continue;
        }
        if (!t.startsWith('-')) break;
        idx++;
        if (ENV_OPERAND_OPTS.has(t) && idx < tokens.length) idx++; // consume separate operand
      }
    } else if (base === 'xargs') {
      while (idx < tokens.length && tokens[idx]!.startsWith('-')) {
        const f = tokens[idx]!;
        idx++;
        if (XARGS_OPERAND_OPTS.has(f) && idx < tokens.length) idx++; // -n N / --max-args N / -I {} …
      }
    } else if (base === 'timeout') {
      while (idx < tokens.length && tokens[idx]!.startsWith('-')) {
        const f = tokens[idx]!;
        idx++;
        // -k/--kill-after and -s/--signal take a value arg before the duration.
        if ((f === '-k' || f === '--kill-after' || f === '-s' || f === '--signal') && idx < tokens.length) idx++;
      }
      if (idx < tokens.length && /^[\d.]+[smhd]?$/.test(tokens[idx]!)) idx++; // duration
    } else if (base === 'nice') {
      while (idx < tokens.length && tokens[idx]!.startsWith('-')) {
        const f = tokens[idx]!;
        idx++;
        if (f === '-n' && idx < tokens.length) idx++;
      }
    } else {
      // command / sudo / nohup / time / stdbuf: skip their own leading flags.
      while (idx < tokens.length && tokens[idx]!.startsWith('-')) {
        const f = tokens[idx]!;
        idx++;
        if ((f === '-u' || f === '--user') && idx < tokens.length) idx++;
      }
    }
  }
  if (idx >= tokens.length) return null;
  return { command: tokens[idx]!, argv: tokens.slice(idx + 1) };
}

// git global flags that consume a following value token (`git -C dir push`,
// `git -c x=y commit`). Value-attached forms (`--git-dir=…`) need no extra skip.
const GIT_GLOBAL_FLAG_WITH_ARG = new Set([
  '-c', '-C', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env',
]);
// `fetch` earns its place here despite leaving the working tree untouched: it
// performs network I/O and rewrites `.git/refs/remotes/*`, so it is neither
// side-effect-free nor idempotent against a moving remote. That matters beyond
// plan mode — `retry-safety.ts` admits a `bashReadOnly`-gated leaf as
// replay-safe, so anything this classifier allows can be re-run wholesale by a
// stream-cut re-dispatch.
const GIT_MUTATING_SUBCMDS = new Set([
  'commit', 'push', 'pull', 'fetch', 'merge', 'rebase', 'reset', 'checkout', 'switch',
  'restore', 'cherry-pick', 'revert', 'am', 'apply', 'clean', 'add', 'rm', 'mv', 'init',
  'clone',
]);

/** Split git argv (tokens after `git`) into the subcommand + its trailing args, skipping global flags. */
function gitSubcommand(argv: readonly string[]): { sub: string | undefined; rest: readonly string[] } {
  let i = 0;
  while (i < argv.length) {
    const t = argv[i]!;
    if (GIT_GLOBAL_FLAG_WITH_ARG.has(t)) {
      i += 2;
      continue;
    }
    if (!t.startsWith('-')) break; // first non-flag token is the subcommand
    i++; // boolean global flag (--no-pager, -p, --bare, --git-dir=…, …)
  }
  return { sub: argv[i], rest: argv.slice(i + 1) };
}

/**
 * Classify a `git …` invocation by its SUBCOMMAND (positionally). Returns a
 * mutation reason, or null for a read-only form. `git config` returns null here —
 * it is matched separately by GIT_CONFIG_* on the raw string (its quoted value
 * must be visible). A `--help`/`-h` flag or the `help` subcommand is read-only.
 */
function gitSegmentReason(argv: readonly string[]): string | null {
  if (argv.includes('--help') || argv.includes('-h')) return null;
  const { sub, rest } = gitSubcommand(argv);
  if (sub === undefined || sub === 'help' || sub === 'config') return null;
  if (GIT_MUTATING_SUBCMDS.has(sub)) return 'git repository mutation';
  const next = rest[0] ?? '';
  switch (sub) {
    case 'tag':
      // `git tag -<flag>` (create/annotate/delete/force) mutates; bare list is fine.
      return next.startsWith('-') ? 'git tag create/delete' : null;
    case 'branch':
      return /^-[dDmMcC]/.test(next) || /^--(delete|move|copy|force)/.test(next)
        ? 'git branch delete/rename'
        : null;
    case 'remote':
      return ['add', 'remove', 'rm', 'set-url', 'rename'].includes(next) ? 'git remote mutation' : null;
    case 'worktree':
      return ['add', 'remove', 'prune', 'move', 'lock', 'unlock'].includes(next)
        ? 'git worktree mutation (add/remove/prune/move)'
        : null;
    case 'stash':
      // `stash list`/`stash show` read; bare `stash` (implicit push) + push/drop/
      // pop/apply/clear/save all mutate.
      return next === 'list' || next === 'show'
        ? null
        : 'git stash mutation (only `stash list`/`stash show` allowed)';
    default:
      return null; // log, status, diff, show, shortlog, blame, grep, ls-files, …
  }
}

const CURL_METHOD_ARG = /^(POST|PUT|PATCH|DELETE)$/i;

/**
 * A `curl` invocation with a write method (`-X POST`, `--request PUT`, `-XPOST`).
 * Runs on the tokenized (quote-removed) argv so a QUOTED method value
 * (`curl -X "POST"`) is caught, while `grep "curl -X POST"` is not — there `curl`
 * is a grep ARGUMENT, never the command-position token. Complements the raw-string
 * CURL_WRITE_METHOD regex, which misses the quoted-value form. (#577)
 */
function curlSegmentMutating(seg: CmdSegment): boolean {
  const base = seg.command.split('/').pop() ?? seg.command;
  if (base !== 'curl') return false;
  for (let i = 0; i < seg.argv.length; i++) {
    const t = seg.argv[i]!;
    if ((t === '-X' || t === '--request') && CURL_METHOD_ARG.test(seg.argv[i + 1] ?? '')) return true;
    if (/^-X(POST|PUT|PATCH|DELETE)$/i.test(t) || /^--request=(POST|PUT|PATCH|DELETE)$/i.test(t)) return true;
  }
  return false;
}

// Backstop (#577): a git repository-mutating verb reached via a construct the
// tokenizer could NOT resolve to command position — a compound command
// (`{ git push; }`, `for … do git push`), an escaped name (`\git push`), or a
// wrapper whose operand parsing fell short (`env -u X git stash`,
// `xargs --max-args 1 git tag -d`). For each bare `git` token that is NOT the
// segment's command, re-run the SAME subcommand classifier on the following
// tokens, so conditional mutations (stash / tag -d / branch -D / remote add /
// worktree remove) are caught too — not just the always-mutating verbs.
// `gitSegmentReason` correctly ALLOWS a mutating verb that is merely a read
// subcommand's ARG (`git log -S push`), and a quoted `"git push"` recon mention
// is a SINGLE token (never split into `git` + `push`), so this cannot
// re-introduce the over-block #574 fixed. Returns the reason, or null.
function hiddenGitMutation(tokens: readonly string[]): string | null {
  for (let i = 0; i < tokens.length - 1; i++) {
    if (baseName(tokens[i]!) === 'git') {
      const reason = gitSegmentReason(tokens.slice(i + 1));
      if (reason !== null) return reason;
    }
  }
  return null;
}

/**
 * Tokenize the command and apply the positional (subcommand-anchored) matchers —
 * git subcommand + curl write-method — over every resolved segment, sharing a
 * variable map so `g=git; $g push` resolves. When a segment's command is NOT git
 * (git hidden by a compound/escape/`eval` form), fall back to `hiddenGitMutation`
 * so obfuscated repo mutations stay blocked. Returns a mutation reason or null.
 */
function tokenizedSegmentReason(command: string): string | null {
  const vars = new Map<string, string>();
  for (const rawTokens of tokenizeSegments(command)) {
    const seg = resolveSegment(rawTokens, vars);
    if (seg === null) {
      const hidden = hiddenGitMutation(rawTokens);
      if (hidden !== null) return hidden;
      continue;
    }
    const base = baseName(seg.command);
    if (base === 'git') {
      const reason = gitSegmentReason(seg.argv);
      if (reason !== null) return reason;
      continue; // resolved git command judged READ — accounted for, skip backstop
    }
    if (base === 'curl' && curlSegmentMutating(seg)) return 'curl write method (POST/PUT/PATCH/DELETE)';
    const hidden = hiddenGitMutation(rawTokens);
    if (hidden !== null) return hidden;
  }
  return null;
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

  // Pass 1 — only rules whose mutation signal can itself be quoted
  // (`git config <key> <value>`, `find -exec <verb>`); see RAW_RULES.
  for (const rule of RAW_RULES) {
    if (rule.re.test(command)) {
      return { mutating: true, reason: rule.reason };
    }
  }

  // Pass 1b — interpreter one-liner writes: capture the quoted `-c`/`-e` payload
  // and test it (and only it) for a write API.
  const interpreterPayload = command.match(INTERPRETER_EVAL)?.[1];
  if (interpreterPayload && INTERPRETER_WRITE_API.test(interpreterPayload)) {
    return { mutating: true, reason: 'interpreter one-liner file write (`-c`/`-e`)' };
  }

  // Pass 1c — positional (subcommand-anchored) matchers over the tokenized
  // command line: git subcommand + curl write-method, resolving `VAR=val;$VAR`
  // indirection, unwrapping no-op wrappers, and recursing into `$(…)` (#577).
  // This REPLACES the old anywhere-in-segment git-verb regexes: anchoring the
  // verb to subcommand position stops recon args from false-matching
  // (`git log -S push`) while catching wrapped/indirected invocations
  // (`g=git; $g push`). The `git stash show stash@{0}` reflog case is handled
  // by reading `stash`'s next token, so no `stash@{N}` pre-strip is needed.
  const tokenReason = tokenizedSegmentReason(command);
  if (tokenReason !== null) {
    return { mutating: true, reason: tokenReason };
  }

  // Pass 2 — the bulk of the rules, evaluated against a view with DATA string
  // literals removed so a quoted search term / verb mention isn't misread.
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
