/** Read one here-string word without changing the shared shell tokenizer.
 * Unsupported expansions fail closed rather than hiding executable input.
 */
import { tokenizeSegments } from './readonly-bash.tokenizer.js';

export type HereString = { text: string; end: number; position: number };

export function hereStringAt(command: string, start: number, position: number): HereString | null {
  let i = start + 3;
  while (command[i] === ' ' || command[i] === '\t') i++;
  const wordStart = i;
  let quote = '';
  for (; i < command.length; i++) {
    const ch = command[i]!;
    // Expansion and escape decoding have their own grammar. Do not guess
    // either the word boundary or the resulting script; retain fail-closed.
    if (quote !== "'" && (ch === '\\' || ch === '`' || ch === '$')) return null;
    if (quote !== '') { if (ch === quote) quote = ''; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (/[\s;&|()<>]/.test(ch)) break;
  }
  if (quote !== '' || i === wordStart || i > command.length) return null;
  const raw = command.slice(wordStart, i);
  const text = tokenizeSegments(`: ${raw}`)[0]?.[1];
  if (text === undefined) return null;
  return { text, end: i, position };
}
