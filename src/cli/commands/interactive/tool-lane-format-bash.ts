/**
 * Command-word emphasis for bash tool-lane rows.
 *
 * Every bash row used to render its whole command in one dim `toolArg` tone,
 * so `cat foo`, `curl …` and `rm -rf …` differed only in dim grey text that a
 * skimming eye passes over. This module finds the word at each COMMAND
 * POSITION (start of input, after `|` `||` `&&` `;` `&` `(` and newlines, and
 * after wrappers such as `sudo` / `env X=1` / `xargs`) and renders those words
 * in `palette.toolVerb`, leaving the arguments in `palette.toolArg`. The verbs
 * then read as distinct shapes at a glance.
 *
 * Contract: display only. This is a deliberately small lexer, not a shell
 * parser: it honours quotes, backslash escapes, comments, redirections and
 * heredoc bodies well enough that ordinary agent-emitted commands highlight
 * the right words, and it fails soft (a missed or extra highlight) on exotic
 * syntax. It makes no safety claim, and nothing may gate behaviour on it; the
 * risk classifier (src/agent/risk-classifier.ts) owns that.
 *
 * Invariant: input may already contain zero-width escape sequences — OSC 8
 * hyperlinks from `shortenPaths` and SGR from upstream styling. They are
 * treated as opaque pieces that are never split and never counted as text,
 * so command positions are found on the visible text only and every escape
 * survives byte-for-byte into the styled output.
 *
 * @module cli/commands/interactive/tool-lane-format-bash
 */

import type { ChalkInstance } from 'chalk';
import { palette } from '../../palette.js';
import { verbFamily, type VerbFamily } from './tool-lane-format-bash-family.js';

/** True for the tool names whose rows get command-word emphasis. */
export function isBashToolName(name: string): boolean {
  return name === 'bash' || name === 'Bash';
}

/** Zero-width escapes: OSC (BEL- or ST-terminated) and CSI sequences. */
const ESCAPE_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Characters that end an unquoted word. */
const WORD_END = /[\s|&;()<>]/;

/** Reserved words after which a command word follows; never highlighted. */
const PREFIX_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{']);

/** Reserved words at command position that are not commands themselves. */
const NON_COMMAND_KEYWORDS = new Set(['for', 'case', 'select', 'function', 'done', 'fi', 'esac', 'in', '}']);

/**
 * Wrappers that run another command. The wrapper itself is highlighted (it is
 * signal: `sudo` matters), and the next non-option word is a command too.
 * Values list the options that consume a following argument, so
 * `sudo -u root rm` highlights `rm`, not `root`.
 */
const WRAPPERS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['sudo', new Set(['-u', '-g', '-C', '-p', '-h', '-U', '-D'])],
  ['doas', new Set(['-u', '-C'])],
  ['env', new Set(['-u', '-C', '-S'])],
  ['nohup', new Set<string>()],
  ['exec', new Set(['-a'])],
  ['command', new Set<string>()],
  ['builtin', new Set<string>()],
  ['time', new Set(['-f', '-o'])],
  ['nice', new Set(['-n'])],
  ['timeout', new Set(['-s', '-k', '--signal', '--kill-after'])],
  ['xargs', new Set(['-n', '-I', '-P', '-L', '-d', '-E', '-s', '-a'])],
]);

/**
 * A command word. `segmentEnd` is where its command segment stops (the next
 * unquoted separator, or end of input) and `afterPipe` records that the
 * segment was entered through a single `|`, so `curl x | bash` can be judged
 * on `| bash` rather than on a bare `bash`.
 */
export interface Span {
  start: number;
  end: number;
  segmentEnd: number;
  afterPipe: boolean;
}

/**
 * Style a bash command for a tool-lane row: command words in a family style
 * (`toolVerb`, `toolVerbNetwork`, `toolVerbDanger`; see
 * tool-lane-format-bash-family.ts), the rest in `toolArg`. With no command
 * word found the result is exactly `palette.toolArg(text)`, so non-command
 * text renders as it always has.
 */
export function styleBashCommand(text: string): string {
  const pieces = splitEscapes(text);
  const plain = pieces.filter((p) => !p.escape).map((p) => p.text).join('');
  const spans = findCommandWordSpans(plain);
  if (spans.length === 0) return palette.toolArg(text);
  const styles = spans.map((span) => FAMILY_STYLE[verbFamily(plain, span)]());
  return renderRuns(pieces, spans, styles);
}

/** Resolved per call: `palette` is a live view over the active theme. */
const FAMILY_STYLE: Record<VerbFamily, () => ChalkInstance> = {
  default: () => palette.toolVerb,
  network: () => palette.toolVerbNetwork,
  danger: () => palette.toolVerbDanger,
};

interface Piece {
  escape: boolean;
  text: string;
}

function splitEscapes(text: string): Piece[] {
  const pieces: Piece[] = [];
  let last = 0;
  for (const match of text.matchAll(ESCAPE_RE)) {
    const start = match.index ?? last;
    if (start > last) pieces.push({ escape: false, text: text.slice(last, start) });
    pieces.push({ escape: true, text: match[0] });
    last = start + match[0].length;
  }
  if (last < text.length) pieces.push({ escape: false, text: text.slice(last) });
  return pieces;
}

/**
 * Re-assemble the pieces into alternating verb / arg runs. Escapes join the
 * run that is open when they occur; they carry no visible text, so which run
 * holds them does not change what the reader sees.
 */
function renderRuns(pieces: Piece[], spans: Span[], styles: ChalkInstance[]): string {
  let out = '';
  let buf = '';
  let bufSpan = -1;
  let offset = 0;
  let spanIndex = 0;
  const flush = (): void => {
    if (buf.length > 0) out += bufSpan === -1 ? palette.toolArg(buf) : styles[bufSpan]!(buf);
    buf = '';
  };
  for (const piece of pieces) {
    if (piece.escape) {
      buf += piece.text;
      continue;
    }
    for (const ch of piece.text) {
      while (spanIndex < spans.length && offset >= spans[spanIndex]!.end) spanIndex++;
      const span = spans[spanIndex];
      const runSpan = span !== undefined && offset >= span.start ? spanIndex : -1;
      if (runSpan !== bufSpan) {
        flush();
        bufSpan = runSpan;
      }
      buf += ch;
      offset += ch.length;
    }
  }
  flush();
  return out;
}

/** End index (exclusive) of the word starting at `i`, honouring quotes and escapes. */
function readWord(s: string, i: number): number {
  let j = i;
  while (j < s.length) {
    const c = s[j]!;
    if (c === '\\') {
      j = Math.min(s.length, j + 2);
    } else if (c === "'") {
      const close = s.indexOf("'", j + 1);
      j = close === -1 ? s.length : close + 1;
    } else if (c === '"' || c === '`') {
      j = skipQuoted(s, j, c);
    } else if (WORD_END.test(c)) {
      break;
    } else {
      j++;
    }
  }
  return j;
}

function skipQuoted(s: string, open: number, quote: string): number {
  let j = open + 1;
  while (j < s.length && s[j] !== quote) j += s[j] === '\\' ? 2 : 1;
  return Math.min(s.length, j + 1);
}

/** Index just past the line that terminates a heredoc body, or end of input. */
function skipHeredocBodies(s: string, bodyStart: number, delimiters: string[]): number {
  let pos = bodyStart;
  for (const delimiter of delimiters) {
    while (pos < s.length) {
      const nl = s.indexOf('\n', pos);
      const lineEnd = nl === -1 ? s.length : nl;
      const line = s.slice(pos, lineEnd);
      pos = nl === -1 ? s.length : nl + 1;
      if (line.trim() === delimiter) break;
    }
  }
  return pos;
}

/**
 * Lex `s` and return the spans of every word sitting at a command position.
 * Pure and linear: each character is visited a bounded number of times.
 */
export function findCommandWordSpans(s: string): Span[] {
  const spans: Span[] = [];
  let atCommand = true;
  let wrapper: ReadonlySet<string> | undefined;
  let skipWrapperValue = false;
  let redirectTarget: 'file' | 'heredoc' | undefined;
  const heredocs: string[] = [];
  let i = 0;
  // Spans pushed since the last separator share one segment; closeSegment
  // stamps where it ends. A comment or heredoc body is never part of it.
  let segmentFirstSpan = 0;
  let segmentAfterPipe = false;
  const closeSegment = (at: number): void => {
    for (let k = segmentFirstSpan; k < spans.length; k++) spans[k]!.segmentEnd = at;
    segmentFirstSpan = spans.length;
  };
  const toCommandPosition = (afterPipe: boolean): void => {
    atCommand = true;
    wrapper = undefined;
    skipWrapperValue = false;
    segmentAfterPipe = afterPipe;
  };
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\n') {
      closeSegment(i);
      i = heredocs.length > 0 ? skipHeredocBodies(s, i + 1, heredocs.splice(0)) : i + 1;
      toCommandPosition(false);
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '<' || c === '>' || (c === '&' && s[i + 1] === '>')) {
      let j = i;
      while (j < s.length && /[<>&]/.test(s[j]!)) j++;
      const op = s.slice(i, j);
      redirectTarget = op === '<<' || op === '<<-' ? 'heredoc' : 'file';
      i = j;
      continue;
    }
    if (c === '|' || c === '&' || c === ';' || c === '(') {
      closeSegment(i);
      const singlePipe = c === '|' && s[i + 1] !== '|' && s[i - 1] !== '|';
      i++;
      toCommandPosition(singlePipe);
      continue;
    }
    if (c === ')') {
      closeSegment(i);
      i++;
      atCommand = false;
      continue;
    }
    const end = Math.max(i + 1, readWord(s, i));
    const word = s.slice(i, end);
    if (word.startsWith('#')) {
      closeSegment(i);
      const nl = s.indexOf('\n', i);
      i = nl === -1 ? s.length : nl;
      continue;
    }
    if (redirectTarget !== undefined) {
      if (redirectTarget === 'heredoc') heredocs.push(word.replace(/^-/, '').replace(/['"\\]/g, ''));
      redirectTarget = undefined;
    } else if (atCommand) {
      classifyCommandWord(word, i, end);
    }
    i = end;
  }
  closeSegment(s.length);
  return spans;

  function classifyCommandWord(word: string, start: number, end: number): void {
    if (skipWrapperValue) {
      skipWrapperValue = false;
      return;
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) return;
    if (wrapper !== undefined && (word.startsWith('-') || /^\d/.test(word))) {
      skipWrapperValue = wrapper.has(word);
      return;
    }
    if (PREFIX_KEYWORDS.has(word)) return;
    if (NON_COMMAND_KEYWORDS.has(word)) {
      atCommand = false;
      return;
    }
    spans.push({ start, end, segmentEnd: s.length, afterPipe: segmentAfterPipe });
    wrapper = WRAPPERS.get(word.split('/').pop() ?? word);
    atCommand = wrapper !== undefined;
  }
}
