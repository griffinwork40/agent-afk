/** Buffers text and structured command output in emission order for HTTP. */
import { stripVTControlCharacters } from 'node:util';
import { createConsoleWriter } from '../cli/slash/writer.js';
import type { WriterSink } from '../cli/slash/writer.js';
import type { Writer } from '../cli/slash/types.js';
import type { OutputBlock } from '../cli/slash/output-blocks.js';
import type { CommandOutputBlock } from './shared/command-wire.js';

export class BufferingWriter implements WriterSink {
  private readonly entries: Array<string | OutputBlock> = [];

  /** WriterSink.fn appends a newline; rawFn preserves the original bytes. */
  fn(line: string): void {
    this.entries.push(line + '\n');
  }

  rawFn(text: string): void {
    this.entries.push(text);
  }

  block(block: OutputBlock): void {
    this.entries.push(structuredClone(block));
  }

  /** Legacy flattened view, including structured blocks' fallback text. */
  getChunks(): string[] {
    return this.entries.map((entry) => typeof entry === 'string' ? entry : entry.ansi);
  }

  asWriterInterface(): Writer {
    return { ...createConsoleWriter(this), block: (block) => this.block(block) };
  }

  /** Read-only snapshot: flush adjacent text around each structured block. */
  toOutputBlocks(): CommandOutputBlock[] {
    const blocks: CommandOutputBlock[] = [];
    let ansi = '';
    const flush = (): void => {
      if (ansi !== '') blocks.push({ kind: 'text', ansi, text: stripVTControlCharacters(ansi) });
      ansi = '';
    };
    for (const entry of this.entries) {
      if (typeof entry === 'string') ansi += entry;
      else {
        flush();
        blocks.push(structuredClone(entry));
      }
    }
    flush();
    return blocks;
  }

  /** Compatibility for callers expecting one legacy text block (even if empty). */
  toOutputBlock(): CommandOutputBlock {
    const ansi = this.getChunks().join('');
    return { ansi, text: stripVTControlCharacters(ansi) };
  }
}
