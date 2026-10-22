/**
 * Tests for the block renderer registry.
 */
import { describe, it, expect } from 'vitest';
import {
  registerBlockRenderer,
  getBlockRenderer,
} from './block-renderer-registry';
import type { CommandOutputBlock } from '@/types/command-wire';
import { createElement } from 'react';

const makeBlock = (overrides: Partial<Pick<CommandOutputBlock, 'ansi' | 'text'>> = {}): CommandOutputBlock => ({
  ansi: 'hello',
  text: 'hello',
  ...overrides,
});

describe('block-renderer-registry', () => {
  it('falls back to text renderer for unknown kind', () => {
    const renderer = getBlockRenderer('__unknown_kind_xyz__');
    expect(typeof renderer).toBe('function');
    // Should not throw on a normal block
    const el = renderer(makeBlock({ ansi: 'test', text: 'test' }));
    expect(el).toBeDefined();
  });

  it('text renderer is registered by default', () => {
    const textRenderer = getBlockRenderer('text');
    expect(typeof textRenderer).toBe('function');
    const el = textRenderer(makeBlock());
    expect(el).toBeDefined();
  });

  it('registers a custom renderer and retrieves it', () => {
    const customRenderer = (block: CommandOutputBlock) =>
      createElement('div', { 'data-kind': 'custom' }, block.text);

    registerBlockRenderer('custom-test', customRenderer);
    const retrieved = getBlockRenderer('custom-test');
    expect(retrieved).toBe(customRenderer);
  });

  it('overwrites a previous registration', () => {
    const r1 = (block: CommandOutputBlock) => createElement('span', null, 'r1-' + block.text);
    const r2 = (block: CommandOutputBlock) => createElement('span', null, 'r2-' + block.text);

    registerBlockRenderer('overwrite-test', r1);
    registerBlockRenderer('overwrite-test', r2);

    const retrieved = getBlockRenderer('overwrite-test');
    expect(retrieved).toBe(r2);
  });

  it('fallback renderer returns a valid React element for a text block', () => {
    const renderer = getBlockRenderer('completely-unknown');
    const el = renderer(makeBlock({ ansi: '\x1b[1mbold\x1b[0m', text: 'bold' }));
    expect(el.type).toBeDefined();
  });
});
