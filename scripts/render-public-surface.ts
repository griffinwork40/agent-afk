#!/usr/bin/env tsx
/** Run via lib/isolated-reference.ts surface, never execute the CLI. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildPublicSurface } from './lib/public-surface-build.js';
import { isMain, repoRoot } from './lib/docs-reference.js';
import type { Surface } from './lib/public-surface.js';

export function renderSurface(surface: Surface): string { return JSON.stringify(surface, null, 2) + '\n'; }

/** Check mode never writes, including when the committed artifact is absent. */
export function writeSurface(surface: Surface, check: boolean, root = repoRoot): boolean {
  const path = join(root, 'docs/public-surface.json');
  const output = renderSurface(surface);
  if (check) {
    if (!existsSync(path) || readFileSync(path, 'utf8') !== output) {
      console.error('Public surface drift: run pnpm scan:surface');
      return false;
    }
    console.log(`Public surface in sync (${surface.symbols.length} symbols)`);
    return true;
  }
  writeFileSync(path, output);
  console.log(`Wrote docs/public-surface.json (${surface.symbols.length} symbols)`);
  return true;
}

if (isMain(import.meta.url)) process.exitCode = writeSurface(buildPublicSurface(), process.argv.includes('--check')) ? 0 : 1;
