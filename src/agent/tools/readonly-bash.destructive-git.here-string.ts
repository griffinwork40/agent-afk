/** Read one here-string word without changing the shared shell tokenizer.
 * A word with expansion or escape syntax is "opaque": its text is unknown, so
 * the caller leaves it in the command as main did (the ordinary passes still
 * see any substitution in it) and fails closed only when it may feed git to a
 * shell. Malformed words (unterminated quote, missing word) return null.
 */
import { tokenizeSegments } from './readonly-bash.tokenizer.js';

/** `text` is the decoded word, or null for an opaque word. `io` is the IO
 * number stripped before `<<<` and `raw` the source after it, so the view can
 * put the exact original text back. `position` indexes the masked header. */
export type HereString = { text: string | null; io: string; raw: string; end: number; position: number };

export function hereStringAt(command: string, start: number, position: number, io: string): HereString | null {
  let i = start + 3;
  while (command[i] === ' ' || command[i] === '\t') i++;
  const wordStart = i;
  let quote = '';
  for (; i < command.length; i++) {
    const ch = command[i]!;
    // Expansion and escape decoding have their own grammar. Do not guess
    // either the word boundary or the resulting script.
    if (quote !== "'" && (ch === '\\' || ch === '`' || ch === '$')) {
      return { text: null, io, raw: '', end: start + 3, position };
    }
    if (quote !== '') { if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/[\s;&|()<>]/.test(ch)) break;
  }
  if (quote !== '' || i === wordStart) return null;
  const text = tokenizeSegments(`: ${command.slice(wordStart, i)}`)[0]?.[1];
  if (text === undefined) return null;
  return { text, io, raw: command.slice(start + 3, i), end: i, position };
}

/** Put each literal here-string back where the masked header replaced it with
 * one space, so the ordinary passes see the same text main did
 * (`cat <<<'git checkout main' |⏎bash` reaches the pipe-to-shell backstop). */
export function restoreHereStrings(header: string, words: readonly HereString[]): string {
  let line = header;
  for (const word of [...words].reverse()) {
    if (word.text === null) continue;
    line = `${line.slice(0, word.position)}${word.io}<<<${word.raw}${line.slice(word.position + 1)}`;
  }
  return line;
}

/** A pipeline that continues onto the next physical line has a consumer this
 * line cannot see (`cat <<<'git reset --hard' |⏎bash`). Fail closed when a
 * pending word may carry git; git-free data (`cat <<<'x' |⏎grep x`) passes. */
export function continuedHereStringPipeline(words: readonly HereString[], preceding: string, header: string): boolean {
  if (!/(?:[|&]|\\)\s*$/.test(header)) return false;
  return words.some((word) => /\bgit\b/.test(word.text ?? `${preceding}${header}`));
}

/** Here-strings feed a word to stdin; unlike heredocs their quotes only
 * protect the outer shell. A shell consumer still executes the quoted text.
 * An opaque word fails closed when a non-data consumer is reached and git
 * appears in the command up to that pipeline (`s='git …'; bash <<< "$s"`).
 */
export function collectHereStrings(
  words: readonly HereString[],
  preceding: string,
  pipeline: (position: number) => { context: string; kind: string },
  scripts: string[],
): string | undefined {
  for (const word of words) {
    const { context, kind } = pipeline(word.position);
    if (word.text === null) {
      if (kind !== 'data' && /\bgit\b/.test(`${preceding}${context}`)) return 'ambiguous here-string word';
      continue;
    }
    if (kind !== 'data') scripts.push(`${preceding}${context}\n${word.text}`);
    if (kind === 'unknown' && /\bgit\b/.test(word.text)) return 'unknown here-string consumer with git payload';
  }
  return undefined;
}
