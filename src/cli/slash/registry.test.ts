/**
 * Tests for src/cli/slash/registry.ts — focused on `createSlashRegistryView`,
 * the adapter the input-buffer colorizer (`colorizeInputBuffer`) uses to decide
 * brand (known command → orange) vs meta (unknown token → dim) coloring.
 *
 * Regression context: aliased commands (e.g. `/quit` → `/exit`, `/t` →
 * `/transcript`) previously colorized DIM in the input line, because all three
 * input surfaces (reader, input-surface, stream-renderer) each built the view
 * from `list()` — which returns canonical commands only — instead of the
 * registry's alias-aware `has()`. This factory is the single source of truth
 * that keeps those surfaces correct together.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import {
  register,
  resetRegistry,
  registryVersion,
  createSlashRegistryView,
  list,
} from './registry.js';
import type { SlashCommand } from './types.js';
import { colorizeInputBuffer } from '../input-highlight.js';
import { palette } from '../palette.js';

const noopHandler: SlashCommand['handler'] = async () => 'continue';

const makeCmd = (name: string, aliases?: string[]): SlashCommand => ({
  name,
  summary: `test ${name}`,
  handler: noopHandler,
  ...(aliases ? { aliases } : {}),
});

describe('createSlashRegistryView', () => {
  beforeEach(() => {
    resetRegistry();
  });
  afterEach(() => {
    resetRegistry();
  });

  it('reports a canonical command name as known', () => {
    register(makeCmd('/exit', ['/quit']));
    // The colorizer strips the leading slash before calling has().
    expect(createSlashRegistryView().has('exit')).toBe(true);
  });

  it('reports an alias as known (regression: /quit rendered dim)', () => {
    register(makeCmd('/exit', ['/quit']));
    expect(createSlashRegistryView().has('quit')).toBe(true);
  });

  it('reports an unknown token as not known', () => {
    register(makeCmd('/exit', ['/quit']));
    expect(createSlashRegistryView().has('notreal')).toBe(false);
  });

  it('documents why the old list()-based adapter mis-colored aliases', () => {
    register(makeCmd('/exit', ['/quit']));
    // list() returns canonical commands only — the alias is absent, which is
    // exactly why an adapter built on `list().some(c => c.name === '/quit')`
    // returned false and painted /quit with the dim/meta tone.
    const canonicalNames = list().map((c) => c.name);
    expect(canonicalNames).toContain('/exit');
    expect(canonicalNames).not.toContain('/quit');
  });

  it('wires version() to registryVersion so the colorizer memo invalidates', () => {
    const view = createSlashRegistryView();
    const before = view.version!();
    expect(before).toBe(registryVersion());
    register(makeCmd('/exit', ['/quit']));
    expect(view.version!()).toBeGreaterThan(before);
  });

  describe('end-to-end via colorizeInputBuffer', () => {
    let prevLevel: 0 | 1 | 2 | 3;
    beforeEach(() => {
      prevLevel = chalk.level;
      // Truecolor so brand (#E67E4C) and meta (blackBright) never collapse to
      // the same downsampled ANSI code — the brand-vs-meta discriminator below
      // must be exact.
      chalk.level = 3;
    });
    afterEach(() => {
      chalk.level = prevLevel;
    });

    it('colors an aliased command with the brand tone, not meta', () => {
      register(makeCmd('/exit', ['/quit']));
      const out = colorizeInputBuffer('/quit', createSlashRegistryView());
      // Known command → brand orange (the same tone its canonical form gets),
      // NOT the dim/meta tone reserved for unknown tokens.
      expect(out).toBe(palette.brand('/quit'));
      expect(out).not.toBe(palette.meta('/quit'));
    });

    it('colors the alias and its canonical form identically', () => {
      register(makeCmd('/exit', ['/quit']));
      const view = createSlashRegistryView();
      expect(colorizeInputBuffer('/quit', view)).toBe(palette.brand('/quit'));
      expect(colorizeInputBuffer('/exit', view)).toBe(palette.brand('/exit'));
    });
  });
});
