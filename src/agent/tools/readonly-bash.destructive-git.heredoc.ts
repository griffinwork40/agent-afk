/** Heredoc command/data boundary for the destructive-git gate only.
 * Never change the shared tokenizer or the readonly/risk policies here.
 * Unsupported syntax retains a fail-closed verdict, not a partly masked input.
 */
import { baseName, resolveSegment, tokenizeSegments } from './readonly-bash.tokenizer.js';
import { SHELL_INTERPS } from './readonly-bash.destructive-git.nested.js';

type Delimiter = { word: string; quoted: boolean; tabs: boolean; end: number };
type View = { command: string; scripts: string[]; uncertain?: string };
type Pending = Delimiter & { position: number };

/** Quote removal for a delimiter word. No parameter/command expansion occurs. */
function delimiterAt(command: string, start: number): Delimiter | null {
  let i = start + 2;
  const tabs = command[i] === '-';
  if (tabs) i++;
  while (command[i] === ' ' || command[i] === '\t') i++;
  let word = '';
  let quoted = false;
  let seen = false;
  while (i < command.length && !/[\s;&|()<>]/.test(command[i]!)) {
    const ch = command[i++]!;
    seen = true;
    if (ch === "'" || ch === '"') {
      quoted = true;
      const end = command.indexOf(ch, i);
      if (end < 0 || command.slice(i, end).includes('\n')) return null;
      const part = command.slice(i, end);
      // Complex double-quote escapes are deliberately not guessed.
      if (ch === '"' && part.includes('\\')) return null;
      word += part;
      i = end + 1;
    } else if (ch === '\\') {
      quoted = true;
      if (i >= command.length || command[i] === '\n') return null;
      word += command[i++]!;
    } else {
      if (ch === '$' || ch === '`') return null;
      word += ch;
    }
  }
  return seen ? { word, quoted, tabs, end: i } : null;
}

/** Only known non-executing consumers earn the data exemption. Unknown
 * consumers (including other languages) keep a conservative git backstop.
 * Inspect every segment: a downstream shell/wrapper must not hide behind cat.
 */
function consumerKind(header: string): 'data' | 'shell' | 'unknown' {
  let unknown = false;
  let count = 0;
  for (const tokens of tokenizeSegments(header)) {
    const segment = resolveSegment(tokens, new Map());
    if (segment === null) { unknown = true; continue; }
    const name = baseName(segment.command);
    if (SHELL_INTERPS.has(name)) return 'shell';
    count++;
    const args = segment.argv;
    const data = name === 'cat' || name === 'tee'
      || (name === 'git' && args[0] === 'commit' && args.some((t, i) => t === '-F' && args[i + 1] === '-'))
      || (name === 'gh' && args.some((t, i) => t === '--body-file' && args[i + 1] === '-'));
    if (!data) unknown = true;
  }
  return count > 0 && !unknown ? 'data' : 'unknown';
}

/** Isolate this heredoc's pipeline, not unrelated commands on the same line.
 * Quoted separators are argv data. Compound/substitution syntax is left in
 * the slice so consumerKind conservatively labels it unknown.
 */
function consumerHeader(header: string, position: number): { consumer: string; context: string } {
  let start = 0;
  let quote = '';
  for (let i = 0; i < header.length; i++) {
    const ch = header[i];
    if (ch === '\\' && quote !== "'") { i++; continue; }
    if (quote !== '') { if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '#' && (i === 0 || /\s/.test(header[i - 1]!))) break;
    if (ch !== ';' && ch !== '&') continue;
    // |& is a pipeline operator, not a command boundary.
    if (ch === '&' && header[i - 1] === '|') continue;
    if (i > position) return { consumer: header.slice(start, i), context: header.slice(0, i) };
    start = i + 1;
  }
  return { consumer: header.slice(start), context: header };
}

/** Expansions run even inside apparent single quotes in an unquoted body.
 * Extract simple command substitutions; complex/unclosed forms fail closed.
 * Escaped $, backtick and backslash are literal; quotes are just body data.
 */
function expansionScripts(body: string): { scripts: string[]; uncertain?: string } {
  const scripts: string[] = [];
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '\\') {
      if (body[i + 1] === '\n') return { scripts, uncertain: 'continued unquoted heredoc' };
      if (/[\\$`]/.test(body[i + 1] ?? '')) i++;
      continue;
    }
    if (ch !== '`' && !(ch === '$' && body[i + 1] === '(')) continue;
    const start = i + (ch === '`' ? 1 : 2);
    let end = start;
    let nesting = 1;
    for (; end < body.length; end++) {
      const c = body[end];
      if (c === '\\') { end++; continue; }
      if (ch === '`') { if (c === '`') break; }
      else {
        // Quotes in a substitution can change parenthesis matching. Rather
        // than remove too much data, retain the fail-closed boundary.
        if (c === "'" || c === '"' || c === '`') return { scripts, uncertain: 'complex heredoc substitution' };
        if (c === '(') nesting++;
        if (c === ')') { nesting--; if (nesting === 0) break; }
      }
    }
    if (end >= body.length) return { scripts, uncertain: 'unterminated heredoc substitution' };
    scripts.push(body.slice(start, end));
    i = end;
  }
  return { scripts };
}

/** Strip bodies from ALL ordinary passes, returning executable payloads
 * separately so quoted data never reaches substitutions or pipe backstops.
 * Headers stay visible, except for the heredoc redirection itself (which is
 * not an argv word and must not hide a git subcommand).
 */
export function destructiveGitHeredocView(command: string): View {
  if (!command.includes('<<')) return { command, scripts: [] };
  const chunks: string[] = [];
  const scripts: string[] = [];
  let pending: Pending[] = [];
  let header = '';
  let quote = '';
  for (let i = 0; i < command.length;) {
    const ch = command[i]!;
    if (ch === '\\' && quote !== "'") {
      const pair = command.slice(i, i + 2);
      header += pair;
      i += pair.length;
      continue;
    }
    if (quote !== '') {
      header += ch;
      if (ch === quote) quote = '';
      i++;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; header += ch; i++; continue; }
    if (ch === '#' && (header === '' || /[\s;|&]$/.test(header))) {
      const end = command.indexOf('\n', i);
      const next = end < 0 ? command.length : end;
      header += command.slice(i, next);
      i = next;
      continue;
    }
    if (command.startsWith('<<', i) && command[i - 1] !== '<') {
      if (command[i + 2] === '<') { header += '<<<'; i += 3; continue; }
      const delimiter = delimiterAt(command, i);
      if (delimiter === null) return { command, scripts, uncertain: 'ambiguous heredoc delimiter' };
      // An adjacent IO number belongs to the redirect, not the argv.
      header = header.replace(/(^|[\s;|&])\d+$/, '$1');
      header += ' ';
      pending.push({ ...delimiter, position: header.length - 1 });
      i = delimiter.end;
      continue;
    }
    if (ch !== '\n') { header += ch; i++; continue; }
    const preceding = chunks.join('');
    chunks.push(`${header}\n`);
    i++;
    // A pipeline can resume AFTER its heredoc terminator. Its eventual
    // consumer is not visible in this header, so do not grant cat an exemption.
    if (pending.length > 0 && /[|&]\\?\s*$/.test(header)) {
      return { command, scripts, uncertain: 'continued heredoc pipeline' };
    }
    const completedHeader = header;
    header = '';
    for (const delimiter of pending) {
      const { consumer, context } = consumerHeader(completedHeader, delimiter.position);
      const kind = consumerKind(consumer);
      const prefix = `${preceding}${context}\n`;
      const body = readBody(command, i, delimiter);
      if (body === null) return { command, scripts, uncertain: 'unterminated heredoc' };
      i = body.end;
      if (!delimiter.quoted) {
        const expansions = expansionScripts(body.text);
        if (expansions.uncertain !== undefined) return { command, scripts, uncertain: expansions.uncertain };
        for (const expansion of expansions.scripts) scripts.push(`${prefix}${expansion}`);
      }
      // Only preceding headers belong in the variable-resolution context:
      // a later assignment must not change a command already run in a body.
      if (kind !== 'data') scripts.push(`${prefix}${body.text}`);
      if (kind === 'unknown' && /\bgit\b/.test(body.text)) {
        return { command, scripts, uncertain: 'unknown heredoc consumer with git payload' };
      }
    }
    pending = [];
  }
  if (pending.length > 0) return { command, scripts, uncertain: 'missing heredoc body' };
  chunks.push(header);
  return { command: chunks.join(''), scripts };
}

function readBody(command: string, start: number, delimiter: Delimiter): { text: string; end: number } | null {
  let text = '';
  for (let i = start; i <= command.length;) {
    const newline = command.indexOf('\n', i);
    const end = newline < 0 ? command.length : newline;
    const raw = command.slice(i, end);
    const line = delimiter.tabs ? raw.replace(/^\t+/, '') : raw;
    if (line === delimiter.word) return { text, end: newline < 0 ? end : end + 1 };
    text += `${line}\n`;
    if (newline < 0) break;
    i = end + 1;
  }
  return null;
}
