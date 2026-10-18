/** `afk ...` command-line resolution for check-docs-refs. Pure functions. */
import type { KnownRefs } from './docs-refs-known.js';

export interface RefFinding { kind: string; token: string; suggestion?: string }

/** Commands that existed once and were removed or renamed. A docs page naming
 * one as a live command is stale even though it would parse as a prompt. */
export const REMOVED_COMMANDS: Readonly<Record<string, string>> = {
  grok: 'afk provider auth xai',
  skill: 'a /skill-name in the REPL (there is no afk skill subcommand)',
};

const SEPARATORS = new Set(['|', '||', '&&', ';', '&']);

export function levenshtein(a: string, b: string): number {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}

export function nearest(token: string, candidates: Iterable<string>, max = Infinity): string | undefined {
  let best: string | undefined;
  let distance = Infinity;
  for (const candidate of candidates) {
    const d = levenshtein(token, candidate);
    if (d < distance) { best = candidate; distance = d; }
  }
  return distance <= max ? best : undefined;
}

export interface ShellToken { text: string; quoted: boolean }

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

/** Segments of a command line that start with `afk` (after `$ `, `VAR=x`, `sudo`). */
export function afkSegments(line: string): ShellToken[][] {
  const tokens = tokenize(line.replace(/^\s*\$\s+/, ''));
  const segments: ShellToken[][] = [[]];
  for (const token of tokens) {
    if (!token.quoted && SEPARATORS.has(token.text)) segments.push([]);
    else segments.at(-1)!.push(token);
  }
  return segments.map((segment) => {
    let start = 0;
    while (start < segment.length && (/^[A-Z_][A-Z0-9_]*=/.test(segment[start]!.text) || ['sudo', 'env', 'exec'].includes(segment[start]!.text))) start++;
    return segment.slice(start);
  }).filter((segment) => segment[0]?.text === 'afk' && !segment[0].quoted);
}

/** Resolve the longest command path, then check every option token. */
export function checkCommand(tokens: readonly ShellToken[], known: KnownRefs): RefFinding[] {
  const findings: RefFinding[] = [];
  let command = known.commands.get('afk');
  if (!command) return [{ kind: 'command', token: 'afk' }];
  let index = 1;
  let resolving = true;
  let verifiable = true;
  for (; index < tokens.length; index++) {
    const { text, quoted } = tokens[index]!;
    if (text === '>') { index++; continue; }
    if (text === '--') break;
    if (text.startsWith('-') && text.length > 1) {
      if (!verifiable) continue;
      const flag = text.replace(/=.*$/, '');
      const root = known.commands.get('afk')!;
      const allowed = new Set([...command.flags, ...root.flags, ...(command.path === 'afk' ? known.commands.get('afk interactive')?.flags ?? [] : [])]);
      if (!allowed.has(flag)) findings.push({ kind: 'flag', token: `${command.path} ${flag}`, suggestion: nearest(flag, allowed) });
      continue;
    }
    if (!resolving) continue;
    resolving = false;
    if (quoted || /[<>[\]{}]|^\.\.\.|\$/.test(text)) { verifiable = verifiable && quoted; continue; }
    const child = known.commands.get(`${command.path} ${text}`);
    if (child) { command = child; resolving = true; continue; }
    const removed = command.path === 'afk' ? REMOVED_COMMANDS[text] : undefined;
    const near = text.length >= 3 ? nearest(text, [...command.children].filter((c) => c.length >= 3), 2) : undefined;
    if (removed) findings.push({ kind: 'command', token: `${command.path} ${text}`, suggestion: removed });
    else if (near && command.children.size) findings.push({ kind: 'command', token: `${command.path} ${text}`, suggestion: `${command.path} ${near}` });
  }
  return findings;
}
