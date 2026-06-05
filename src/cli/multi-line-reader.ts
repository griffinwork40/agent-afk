/**
 * Multi-line reader + Tab completion wrapper around Node's readline.
 *
 * Behavior:
 *   - A line ending in `\` is a continuation — the reader prompts again
 *     and concatenates the next line as a new paragraph.
 *   - Tab completes slash commands when the line starts with `/`.
 *   - Tab completes file paths when the current token starts with `@`.
 *   - On non-TTY stdin, degrades to a plain `rl.question` single-line read.
 */

import { readdirSync, statSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Interface as ReadlineInterface } from 'readline';
import { list as listSlashCommands } from './slash/registry.js';

export type Completer = (line: string) => [string[], string];

/**
 * Build the production completer.
 *
 * Slash completion reads from the registry; file completion walks the cwd.
 * The `rootDir` parameter exists so tests can point at a fixture directory.
 */
export function buildCompleter(rootDir: string = process.cwd()): Completer {
  return (line: string): [string[], string] => {
    const trimmed = line;

    // Slash-command completion — only when line starts with `/`.
    if (trimmed.startsWith('/')) {
      const names = listSlashCommands().map((c) => c.name);
      const matches = names.filter((n) => n.startsWith(trimmed));
      return [matches, trimmed];
    }

    // File-path completion — last @-prefixed token.
    const lastToken = trimmed.split(/\s+/).pop() ?? '';
    if (lastToken.startsWith('@')) {
      const prefix = lastToken.slice(1);
      const matches = fileMatchesFor(prefix, rootDir).map((m) => '@' + m);
      return [matches, lastToken];
    }

    return [[], trimmed];
  };
}

/**
 * Upper bound on @-file completion candidates returned per scan. The dropdown
 * renders MAX_DROPDOWN_ROWS at a time and scrolls, so this bounds how far the
 * user can scroll — not the visible row count. It is the SINGLE source of
 * truth for the file-candidate cap: downstream callers must not re-cap, or the
 * smaller cap silently wins and hides reachable entries (the bug this fixes).
 */
export const MAX_FILE_MATCHES = 50;

/**
 * Normalise an `@`-completion query into the directory to scan, the leaf
 * prefix to match entries against, and the display prefix to prepend to each
 * candidate so the user's typed form (`~/`, `/abs/`, `rel/`) is preserved in
 * the dropdown rather than expanded to an absolute path.
 *
 * Three modes:
 *   - tilde    (`~` or `~/...`) → scan under `homeDir`, display as `~/...`
 *   - absolute (`/...`)         → scan the absolute prefix verbatim
 *   - relative (everything else)→ scan `join(rootDir, scanRel)` (legacy)
 *
 * Pure: no I/O. `homeDir` is injectable for test isolation; production calls
 * let it default to `os.homedir()`, mirroring the `rootDir = process.cwd()`
 * convention used throughout the input layer.
 */
export function resolveQuery(
  query: string,
  rootDir: string,
  homeDir: string = homedir(),
): { scanDir: string; leafPrefix: string; displayPrefix: string } {
  // Tilde: `~` or `~/<rest>` resolve against the home directory. Only the
  // current user's home (`~/`) is supported — `~user/` is treated as relative.
  if (query === '~' || query.startsWith('~/')) {
    const rest = query === '~' ? '' : query.slice(2);
    const slashIdx = rest.lastIndexOf('/');
    const scanRel = slashIdx === -1 ? '' : rest.slice(0, slashIdx);
    const leafPrefix = slashIdx === -1 ? rest : rest.slice(slashIdx + 1);
    const scanDir = scanRel ? join(homeDir, scanRel) : homeDir;
    const displayPrefix = scanRel ? `~/${scanRel}/` : '~/';
    return { scanDir, leafPrefix, displayPrefix };
  }

  // Absolute: scan the directory portion of the path verbatim, bypassing
  // rootDir entirely. The display prefix is the absolute directory itself.
  if (query.startsWith('/')) {
    const slashIdx = query.lastIndexOf('/');
    const scanDir = query.slice(0, slashIdx + 1) || '/';
    const leafPrefix = query.slice(slashIdx + 1);
    return { scanDir, leafPrefix, displayPrefix: scanDir };
  }

  // Relative (legacy behavior): join the dir portion against rootDir.
  const slashIdx = query.lastIndexOf('/');
  const scanRel = slashIdx === -1 ? '' : query.slice(0, slashIdx);
  const leafPrefix = slashIdx === -1 ? query : query.slice(slashIdx + 1);
  const scanDir = scanRel ? join(rootDir, scanRel) : rootDir;
  const displayPrefix = scanRel ? `${scanRel}/` : '';
  return { scanDir, leafPrefix, displayPrefix };
}

export function fileMatchesFor(prefix: string, rootDir: string = process.cwd()): string[] {
  try {
    const { scanDir, leafPrefix, displayPrefix } = resolveQuery(prefix, rootDir);
    // Invariant: sort BEFORE capping. readdirSync returns entries in an
    // unspecified OS order, so capping mid-scan kept an arbitrary subset and
    // could drop alphabetically-early entries. Filter → sort names → cap →
    // stat: the stat (dir trailing-slash decoration) then runs only on the
    // ≤MAX_FILE_MATCHES survivors, bounding IO on huge dirs.
    const names = readdirSync(scanDir)
      .filter((name) => name.startsWith(leafPrefix))
      .filter((name) => !(name.startsWith('.') && !leafPrefix.startsWith('.')))
      .sort()
      .slice(0, MAX_FILE_MATCHES);
    return names.map((name) => {
      let relPath = displayPrefix + name;
      try {
        if (statSync(join(scanDir, name)).isDirectory()) relPath += '/';
      } catch {
        // ignore — stat errors don't block completion
      }
      return relPath;
    });
  } catch {
    return [];
  }
}

export interface MultiLineReaderOptions {
  rl: ReadlineInterface;
  promptFn: () => string;
  /** Continuation prompt shown on lines 2..n. */
  continuationPrompt?: string;
}

/** Read a single (possibly multi-line via trailing-\) user input. */
export async function readInput(opts: MultiLineReaderOptions): Promise<string> {
  let buffer = '';
  let prompt = opts.promptFn();
  const cont = opts.continuationPrompt ?? '  › ';

  while (true) {
    // Use rl.setPrompt + rl.prompt + one-shot 'line' listener instead of rl.question.
    // rl.question sets an internal _questionCallback on the readline interface and,
    // across repeated calls with async work between, that state can wedge so the next
    // call never fires its callback (input echoes but Enter is swallowed). A plain
    // 'line' listener sidesteps that state machine entirely.
    opts.rl.setPrompt(prompt);
    opts.rl.prompt();
    const line: string = await new Promise((resolve) => {
      opts.rl.once('line', (input: string) => resolve(input));
    });
    if (line.endsWith('\\')) {
      buffer += line.slice(0, -1) + '\n';
      prompt = cont;
      continue;
    }
    buffer += line;
    return buffer;
  }
}
