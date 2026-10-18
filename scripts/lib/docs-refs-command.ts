/** `afk ...` command-line resolution for check-docs-refs. Pure functions. */
import type { CommandInfo, KnownRefs } from './docs-refs-known.js';
import type { ShellToken } from './docs-refs-shell.js';

export interface RefFinding { kind: string; token: string; suggestion?: string }

/** Commands that existed once and were removed or renamed. A docs page naming
 * one as a live command is stale even though it would parse as a prompt. */
export const REMOVED_COMMANDS: Readonly<Record<string, string>> = {
  grok: 'afk provider auth xai',
  skill: 'a /skill-name in the REPL (there is no afk skill subcommand)',
};

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

export { afkSegments, startsWithAfk, tokenize, type ShellToken } from './docs-refs-shell.js';

const PLACEHOLDER = /[<>[\]{}]|^\.\.\.|\$/;
/** Option-shaped words only: `--x`, `-x`, `--x=v`. Prose like `--x?` or `-->` is a value. */
const OPTION = /^--?[A-Za-z0-9][\w-]*(?:=|$)/;

/** Options visible at `command`: its own, the root's, and (at the root) the
 * default `interactive` command's, which `afk --model x` reaches. */
function optionScope(command: CommandInfo, known: KnownRefs): CommandInfo[] {
  const root = known.commands.get('afk')!;
  const scopes = [command, root];
  const interactive = known.commands.get('afk interactive');
  if (command.path === 'afk' && interactive) scopes.push(interactive);
  return scopes;
}

/** Resolve the longest command path, then check every option token. Option
 * arguments are consumed by arity (`<v>` required, `[v]` optional when the
 * next word is not an option), so `--name "--x"` and `--model x sub` work.
 * An unquoted placeholder in a positional slot stops resolution; later options
 * are still checked unless the slot could have been a subcommand. */
export function checkCommand(tokens: readonly ShellToken[], known: KnownRefs): RefFinding[] {
  const findings: RefFinding[] = [];
  let command = known.commands.get('afk');
  if (!command) return [{ kind: 'command', token: 'afk' }];
  let resolving = true;
  let verifiable = true;
  for (let index = 1; index < tokens.length; index++) {
    const { text, quoted } = tokens[index]!;
    if (text === '>' && !quoted) { index++; continue; }
    if (text === '--') break;
    if (OPTION.test(text) && !quoted) {
      const flag = text.replace(/=.*$/, '');
      const scopes = optionScope(command, known);
      const arity = scopes.map((scope) => scope.args.get(flag)).find(Boolean);
      const next = tokens[index + 1];
      if (!text.includes('=') && next && (arity === 'required' || (arity === 'optional' && !next.text.startsWith('-')))) index++;
      if (!verifiable) continue;
      const allowed = new Set(scopes.flatMap((scope) => [...scope.flags]));
      if (!allowed.has(flag)) findings.push({ kind: 'flag', token: `${command.path} ${flag}`, suggestion: nearest(flag, allowed) });
      continue;
    }
    if (!resolving) continue;
    resolving = false;
    if (quoted) continue;
    if (PLACEHOLDER.test(text)) { if (command.children.size && command.path !== 'afk') verifiable = false; continue; }
    const child = known.commands.get(`${command.path} ${text}`);
    if (child) { command = child; resolving = true; continue; }
    const removed = command.path === 'afk' ? REMOVED_COMMANDS[text] : undefined;
    const near = text.length >= 3 ? nearest(text, [...command.children].filter((c) => c.length >= 3), 2) : undefined;
    if (removed) findings.push({ kind: 'command', token: `${command.path} ${text}`, suggestion: removed });
    else if (near && command.children.size) findings.push({ kind: 'command', token: `${command.path} ${text}`, suggestion: `${command.path} ${near}` });
  }
  return findings;
}
