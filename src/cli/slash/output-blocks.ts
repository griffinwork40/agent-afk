/** Portable command output: every variant carries a plain and ANSI fallback. */
export { writeTable, writeKeyValue, writeDiff, writeList, writeLink } from './output-blocks.format.js';

type Fallback = { text: string; ansi: string };
export type OutputBlock = Fallback & (
  | { kind: 'text' }
  | { kind: 'table'; title?: string; columns: string[]; rows: string[][] }
  | { kind: 'keyValue'; title?: string; entries: Array<{ key: string; value: string }> }
  | { kind: 'diff'; diff: string; fileName?: string }
  | { kind: 'list'; title?: string; items: Array<{ text: string; description?: string }> }
  | { kind: 'link'; url: string; label: string }
);

export type BlockData<K extends OutputBlock['kind']> = Omit<
  Extract<OutputBlock, { kind: K }>, 'kind' | 'text' | 'ansi'
>;
