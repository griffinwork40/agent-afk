/**
 * Generic argv walker for the wait_for read-only allowlists.
 *
 * Contract: a token not starting with `-` is a positional argument (path,
 * pattern, URL, ref) and is accepted unless `noPositional` is set. A separate
 * flag VALUE (`-n 5`, `--format %H`) is therefore also accepted as a
 * positional — harmless, because positionals are never trusted to be flags,
 * and a value that itself starts with `-` is validated as a flag (fail closed).
 * Long flags match by exact name before any `=`; short clusters (`-sb`) must
 * consist of allowed shorts, and a short in `valueShorts` ends the cluster
 * (`-n5`, `-U3`: the rest is its attached value).
 *
 * @module agent/tools/handlers/wait-for-poll-allowlist.argv
 */

export interface ArgvSpec {
  /** Allowed flag spellings, long (`--stat`) and short (`-s`). */
  readonly flags: ReadonlySet<string>;
  /** Short flag letters that take an attached value (`-n5`). */
  readonly valueShorts?: string;
  /** Accept bare numeric counts such as `git log -1`. */
  readonly numeric?: boolean;
  /** Refuse every positional argument (e.g. `git branch <name>` creates). */
  readonly noPositional?: boolean;
  /** First positional must be one of these verbs (e.g. `git stash list`). */
  readonly verbs?: ReadonlySet<string>;
  /** At least one of these flags must be present (read mode selector). */
  readonly requireAny?: ReadonlySet<string>;
}

function shortClusterAllowed(token: string, spec: ArgvSpec): boolean {
  for (const c of token.slice(1)) {
    if (!spec.flags.has(`-${c}`)) return false;
    if (spec.valueShorts?.includes(c) === true) return true;
  }
  return true;
}

/** True when every token of `argv` is an allowed flag or (permitted) positional. */
export function argvAllowed(argv: readonly string[], spec: ArgvSpec): boolean {
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i]!;
    if (t === '--') return spec.noPositional !== true || i === argv.length - 1;
    if (!t.startsWith('-') || t === '-') {
      if (spec.noPositional === true) return false;
      continue;
    }
    if (spec.numeric === true && /^-\d+$/.test(t)) continue;
    if (t.startsWith('--')) {
      if (!spec.flags.has(t.split('=', 1)[0]!)) return false;
      continue;
    }
    if (!shortClusterAllowed(t, spec)) return false;
  }
  return true;
}
