/**
 * Command-line tokenizer for the readonly-bash classifier.
 *
 * Extracted from `readonly-bash.ts` to keep that file within the 350-code-
 * line ceiling. This module owns the positional (subcommand-anchored) matching
 * layer (Pass 1c in the classifier): tokenizeSegments, resolveSegment,
 * gitSegmentReason, curlSegmentMutating, hiddenGitMutation, and the public
 * entry point tokenizedSegmentReason.
 *
 * History: the git repository-mutation and curl-method rules used to match verb
 * regexes against the whole (quote-stripped) command string. A string match
 * cannot tell a verb in COMMAND position from the same word in an ARGUMENT, so
 * it over-blocked recon (`git log -S push`) and under-blocked mutations reached
 * via a wrapper (`env`/`xargs`/`command`/`sudo`/`busybox`), a shell variable
 * (`g=git; $g push`), or a `$(…)`/backtick substitution. This tokenizer splits
 * a command into pipeline/chaining segments, resolves ONE level of `VAR=val;$VAR`
 * indirection, unwraps no-op wrappers, and recurses into command substitutions,
 * so `gitSegmentReason` / `curlSegmentMutating` see the EFFECTIVE command in
 * command position and the verb in subcommand position. It is intentionally a
 * best-effort tokenizer matching the classifier's threat model (a well-behaved
 * recon agent, not a hostile process) — NOT a full POSIX shell parser.
 *
 * @module agent/tools/readonly-bash.tokenizer
 */

/** A resolved command segment: the effective command token + its remaining argv. */
export interface CmdSegment {
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
export function baseName(cmd: string): string {
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
export function tokenizeSegments(command: string): string[][] {
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
export function resolveSegment(rawTokens: readonly string[], vars: Map<string, string>): CmdSegment | null {
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
export function gitSegmentReason(argv: readonly string[]): string | null {
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
export function curlSegmentMutating(seg: CmdSegment): boolean {
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
export function tokenizedSegmentReason(command: string): string | null {
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
