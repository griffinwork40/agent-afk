import { stripVTControlCharacters as plain } from 'node:util';
import type { BlockData, OutputBlock } from './output-blocks.js';
import type { Writer } from './types.js';

/**
 * Keep the original renderer in the caller: a generic formatter cannot reproduce
 * its palette, spacing, terminal width handling, or raw/newline choices exactly.
 * Writers without block support therefore execute the legacy callback verbatim.
 */
export function writeTable(out: Writer, data: BlockData<'table'>, legacy: () => void): void {
  if (out.block) out.block(formatOutputBlock({ kind: 'table', ...data }));
  else legacy();
}

export function writeKeyValue(out: Writer, data: BlockData<'keyValue'>, legacy: () => void): void {
  if (out.block) out.block(formatOutputBlock({ kind: 'keyValue', ...data }));
  else legacy();
}

export function writeDiff(out: Writer, data: BlockData<'diff'>, legacy: () => void): void {
  if (out.block) out.block(formatOutputBlock({ kind: 'diff', ...data }));
  else legacy();
}

export function writeList(out: Writer, data: BlockData<'list'>, legacy: () => void): void {
  if (out.block) out.block(formatOutputBlock({ kind: 'list', ...data }));
  else legacy();
}

export function writeLink(out: Writer, data: BlockData<'link'>, legacy: () => void): void {
  if (out.block) out.block(formatOutputBlock({ kind: 'link', ...data }));
  else legacy();
}

type StructuredKind = Exclude<OutputBlock['kind'], 'text'>;
type StructuredData = { [K in StructuredKind]: { kind: K } & BlockData<K> }[StructuredKind];

function fallback(lines: string[], title?: string): { text: string; ansi: string } {
  const text = [...(title === undefined ? [] : [title]), ...lines].join('\n') + '\n';
  return { text, ansi: text };
}

/** Structured fields are data, never terminal markup; fallback is deterministic. */
export function formatOutputBlock(data: StructuredData): OutputBlock {
  switch (data.kind) {
    case 'table': {
      const title = data.title === undefined ? undefined : plain(data.title);
      const columns = data.columns.map(plain);
      const rows = data.rows.map((row) => row.map(plain));
      return { kind: data.kind, title, columns, rows,
        ...fallback([columns.join(' | '), ...rows.map((row) => row.join(' | '))], title) };
    }
    case 'keyValue': {
      const title = data.title === undefined ? undefined : plain(data.title);
      const entries = data.entries.map(({ key, value }) => ({ key: plain(key), value: plain(value) }));
      return { kind: data.kind, title, entries,
        ...fallback(entries.map(({ key, value }) => `${key}: ${value}`), title) };
    }
    case 'diff': {
      const diff = plain(data.diff);
      const fileName = data.fileName === undefined ? undefined : plain(data.fileName);
      return { kind: data.kind, diff, fileName, ...fallback([diff], fileName) };
    }
    case 'list': {
      const title = data.title === undefined ? undefined : plain(data.title);
      const items = data.items.map(({ text, description }) => ({
        text: plain(text), description: description === undefined ? undefined : plain(description),
      }));
      return { kind: data.kind, title, items, ...fallback(items.map(({ text, description }) =>
        `- ${text}${description === undefined ? '' : `: ${description}`}`), title) };
    }
    case 'link': {
      const url = plain(data.url);
      const label = plain(data.label);
      return { kind: data.kind, url, label, ...fallback([`${label}: ${url}`]) };
    }
  }
}
