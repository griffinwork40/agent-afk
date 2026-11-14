/** Shell-line parsing for check-docs-refs: tokenizing, prompt and runner
 * prefixes, command substitution, and `afk` segment extraction. Pure functions.
 */

export interface ShellToken { text: string; quoted: boolean }

const SEPARATORS = new Set(['|', '||', '&&', ';', '&']);
/** Prompts a docs example may show before the command: `$ `, `% `, `> `, `PS> `, `PS C:\x> `. */
const PROMPT = /^\s*(?:\$|%|>|PS(?: [^>]*)?>)\s+/;
/** Package runners that execute the next word as a binary (`npx afk`, `pnpm exec afk`). */
const RUNNERS = new Set(['npx', 'bunx', 'pnpx', 'pnpm', 'yarn', 'npm', 'bun']);
const RUNNER_VERBS = new Set(['exec', 'dlx', 'x', 'run']);
/** Runner options that take a value (`npx -p agent-afk afk`). */
const RUNNER_VALUE_FLAGS = new Set(['-p', '--package', '-c', '--call', '-C', '--dir', '--filter', '-F']);
const WRAPPERS = new Set(['sudo', 'env', 'exec', 'command', 'time', 'nohup']);

/** Shell-ish tokenizer: quotes group, separators and redirections split,
 * `#` (at a word start) ends the line. Values are returned unquoted. */
export function tokenize(line: string): ShellToken[] {
  const out: ShellToken[] = [];
  let i = 0;
  while (i < line.length) {
    const char = line[i]!;
    if (/\s/.test(char)) { i++; continue; }
    if (char === '#') break;
    const op = /^(\|\||&&|[|;&]|\d?>>?|<)/.exec(line.slice(i));
    if (op) { out.push({ text: /[<>]/.test(op[1]!) ? '>' : op[1]!, quoted: false }); i += op[1]!.length; continue; }
    let text = '';
    let quoted = false;
    while (i < line.length && !/[\s|;&<>]/.test(line[i]!)) {
      const c = line[i]!;
      if (c === '"' || c === "'") {
        const end = line.indexOf(c, i + 1);
        text += line.slice(i + 1, end === -1 ? line.length : end);
        quoted = true;
        i = end === -1 ? line.length : end + 1;
      } else if (c === '\\' && i + 1 < line.length) { text += line[i + 1]; i += 2; } else { text += c; i++; }
    }
    out.push({ text, quoted });
  }
  return out;
}

/** Split out `$(...)` and backtick substitutions. The outer line keeps a
 * `$__SUB` placeholder in their place so it still reads as a value. */
export function substitutions(line: string): { outer: string; inner: string[] } {
  const inner: string[] = [];
  let outer = '';
  let i = 0;
  while (i < line.length) {
    if (line.startsWith('$(', i) && !line.startsWith('$((', i)) {
      let depth = 1;
      let j = i + 2;
      for (; j < line.length && depth; j++) depth += line[j] === '(' ? 1 : line[j] === ')' ? -1 : 0;
      inner.push(line.slice(i + 2, depth ? j : j - 1));
      outer += '$__SUB';
      i = j;
    } else if (line[i] === '`' && line.indexOf('`', i + 1) !== -1) {
      const end = line.indexOf('`', i + 1);
      inner.push(line.slice(i + 1, end));
      outer += '$__SUB';
      i = end + 1;
    } else { outer += line[i]; i++; }
  }
  return { outer, inner };
}

/** Drop env assignments, wrappers (`sudo`), and package runners before the binary. */
function stripPrefix(segment: ShellToken[]): ShellToken[] {
  let start = 0;
  let runner = false;
  while (start < segment.length) {
    const { text, quoted } = segment[start]!;
    if (quoted) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(text) || WRAPPERS.has(text)) { start++; continue; }
    if (RUNNERS.has(text)) { runner = true; start++; continue; }
    if (runner && (RUNNER_VERBS.has(text) || text === '--')) { start++; continue; }
    if (runner && RUNNER_VALUE_FLAGS.has(text) && !/^[@a-z0-9/-]*afk$/.test(segment[start + 1]?.text ?? '')) { start += 2; continue; }
    if (runner && text.startsWith('-')) { start++; continue; }
    break;
  }
  return segment.slice(start);
}

/** Every simple command on the line (after prompts, prefixes, runners), plus
 * the commands inside substitutions. `first` is the line's leading command. */
export function commandSegments(line: string): { first: ShellToken[]; all: ShellToken[][] } {
  const { outer, inner } = substitutions(line.replace(PROMPT, ''));
  const segments: ShellToken[][] = [[]];
  for (const token of tokenize(outer)) {
    if (!token.quoted && SEPARATORS.has(token.text)) segments.push([]);
    else segments.at(-1)!.push(token);
  }
  const stripped = segments.map(stripPrefix);
  return { first: stripped[0]!, all: [...stripped, ...inner.flatMap((text) => commandSegments(text).all)] };
}

const isAfk = (segment: readonly ShellToken[]): boolean => segment[0]?.text === 'afk' && !segment[0].quoted;

/** Segments of a command line that invoke `afk`. */
export function afkSegments(line: string): ShellToken[][] {
  return commandSegments(line).all.filter(isAfk);
}

/** True when the line's leading command is `afk` (non-shell fences check only these). */
export function startsWithAfk(line: string): boolean {
  return isAfk(commandSegments(line).first);
}
