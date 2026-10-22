/**
 * Block renderer registry for command-output transcript items.
 *
 * Each block kind maps to a render function `(block) => ReactElement`.
 * Unknown kinds fall back to the built-in text renderer.
 *
 * The text renderer is registered at module load so it is always available.
 */

import { createElement, type ReactElement } from 'react';
import { renderAnsi } from './ansi-renderer';
import type { CommandOutputBlock } from '@/types/command-wire';
import { renderTable } from '@/renderers/table';
import { renderKeyValue } from '@/renderers/key-value';
import { renderDiff } from '@/renderers/diff';
import { renderList } from '@/renderers/list';
import { renderLink } from '@/renderers/link';

export type BlockRenderer = (block: CommandOutputBlock) => ReactElement;

const registry = new Map<string, BlockRenderer>();

/** Register a renderer for a block kind. Overwrites any previous registration. */
export function registerBlockRenderer(kind: string, fn: BlockRenderer): void {
  registry.set(kind, fn);
}

/** Retrieve a renderer for a block kind, falling back to the text renderer. */
export function getBlockRenderer(kind: string): BlockRenderer {
  return registry.get(kind) ?? plainTextRenderer;
}

// ---------------------------------------------------------------------------
// Built-in text renderer (registered at module load)
// ---------------------------------------------------------------------------

const plainTextRenderer: BlockRenderer = (block) => createElement('span', null, block.text);

const textRenderer: BlockRenderer = (block) => {
  try {
    return renderAnsi(block.ansi);
  } catch {
    return createElement('span', null, block.text);
  }
};

registerBlockRenderer('text', textRenderer);
registerBlockRenderer('table', renderTable);
registerBlockRenderer('keyValue', renderKeyValue);
registerBlockRenderer('diff', renderDiff);
registerBlockRenderer('list', renderList);
registerBlockRenderer('link', renderLink);
