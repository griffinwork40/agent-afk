import { describe, expect, it, vi } from 'vitest';
import { createConsoleWriter } from './writer.js';
import { writeTable, writeKeyValue, writeDiff, writeList, writeLink } from './output-blocks.js';
import type { OutputBlock } from './output-blocks.js';
import type { Writer } from './types.js';
import type { CommandOutputBlock } from '../../web-server/shared/command-wire.js';

const colored = '\x1b[31mvalue\x1b[0m';
const cases: Array<{
  kind: OutputBlock['kind'];
  emit: (out: Writer, legacy: () => void) => void;
  text: string;
}> = [
  { kind: 'table', emit: (out, legacy) => writeTable(out,
    { title: colored, columns: [colored], rows: [[colored]] }, legacy), text: 'value\nvalue\nvalue\n' },
  { kind: 'keyValue', emit: (out, legacy) => writeKeyValue(out,
    { title: colored, entries: [{ key: colored, value: colored }] }, legacy), text: 'value\nvalue: value\n' },
  { kind: 'diff', emit: (out, legacy) => writeDiff(out,
    { fileName: colored, diff: colored }, legacy), text: 'value\nvalue\n' },
  { kind: 'list', emit: (out, legacy) => writeList(out,
    { title: colored, items: [{ text: colored, description: colored }, { text: colored }] }, legacy),
    text: 'value\n- value: value\n- value\n' },
  { kind: 'link', emit: (out, legacy) => writeLink(out,
    { label: colored, url: colored }, legacy), text: 'value: value\n' },
];

describe('structured output helpers', () => {
  for (const sample of cases) {
    it(`${sample.kind} emits serializable plain data and fallback without legacy writes`, () => {
      const blocks: OutputBlock[] = [];
      const out = { ...createConsoleWriter({ fn: vi.fn() }), block: (b: OutputBlock) => blocks.push(b) };
      const legacy = vi.fn();
      sample.emit(out, legacy);
      expect(legacy).not.toHaveBeenCalled();
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ kind: sample.kind, text: sample.text, ansi: sample.text });
      const wire: CommandOutputBlock[] = blocks;
      expect(JSON.stringify(wire)).not.toContain('\\u001b');
      expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
    });

    it(`${sample.kind} preserves exact caller bytes on a legacy writer`, () => {
      const chunks: string[] = [];
      const out = createConsoleWriter({ fn: (line) => chunks.push(line + '\n'), rawFn: (text) => chunks.push(text) });
      const legacy = vi.fn(() => { out.raw(colored); out.line('  padded'); });
      sample.emit(out, legacy);
      expect(legacy).toHaveBeenCalledOnce();
      expect(chunks.join('')).toBe(colored + '  padded\n');
    });
  }

  it('handles empty fields without optional titles', () => {
    const block = vi.fn();
    const out = { ...createConsoleWriter({ fn: vi.fn() }), block };
    writeTable(out, { columns: [], rows: [] }, vi.fn());
    writeKeyValue(out, { entries: [] }, vi.fn());
    writeList(out, { items: [] }, vi.fn());
    writeDiff(out, { diff: '' }, vi.fn());
    expect(block.mock.calls.map(([b]) => b.text)).toEqual(['\n', '\n', '\n', '\n']);
  });
});
