import { stripEscapeSequences } from '../utils/terminal-sanitize.js';

// terminal-sanitize is dependency-free, so this import is safe in Workers too.
const INVISIBLE = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u200b-\u200d\u2060\ufeff\u00ad\u180e\u{e0000}-\u{e007f}]/gu;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;

export function sanitizeChatText(input: string): string {
  // Remove invisibles first so they cannot hide a terminal sequence from the stripper.
  return stripEscapeSequences(input.replace(INVISIBLE, ''))
    .replace(/[\r\n\t\u2028\u2029]+/g, ' ').replace(CONTROLS, ' ').trim();
}
export function sanitizeChatName(input: string): string {
  return sanitizeChatText(input);
}
/** Count explicit HTTP(S) and www links, including Markdown destinations. */
export function countLinks(text: string): number {
  return Array.from(text.matchAll(/(?:https?:\/\/|www\.)[^\s<>]+/gi)).length;
}
