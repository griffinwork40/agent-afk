#!/usr/bin/env tsx
/**
 * Contract: after resolving code conflicts, regenerate and stage derivable files.
 * Conflicted ratchets first receive both index sides' approvals (maxima), never
 * a blanket growth exemption. A regenerator's refusal stops before git add.
 * Outside a conflict the same command refreshes everything.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseGrowthArgs } from './lib/growth-args.js';
import {
  GENERATED_PATHS, parseBaseline, unionBaselines, unionPosix, unionTypecheck,
  type TypecheckBaseline,
} from './lib/regen-generated-union.js';
import { serializeBaseline } from './lib/size-ratchet.js';
import { serializePosixBaseline, type PosixBaseline } from './lib/posix-guard.js';

/** Git failures are fatal, not evidence that there are no conflicts. */
function git(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function paths(root: string, args: string[]): string[] {
  return git(root, [...args, '-z']).split('\0').filter(Boolean);
}

/** Contract: only a missing stage is tolerated; other git failures are fatal. */
function readStage(root: string, stage: 2 | 3, file: string): string {
  const present = git(root, ['ls-files', '--unmerged', '--', file])
    .split('\n').some((line) => line.split('\t')[0]?.endsWith(` ${stage}`));
  return present ? git(root, ['show', `:${stage}:${file}`]) : '';
}

function parsePosixStage(raw: string): PosixBaseline | null {
  if (!raw.trim()) return null;
  const parsed = JSON.parse(raw) as PosixBaseline;
  if (!parsed.entries || typeof parsed.entries !== 'object') throw new Error('Invalid POSIX baseline: missing entries');
  for (const [key, counts] of Object.entries(parsed.entries)) {
    if (counts === null || typeof counts !== 'object') throw new Error(`Invalid POSIX baseline: entry value for "${key}" must be a plain object`);
    for (const v of Object.values(counts as Record<string, unknown>)) {
      if (!Number.isFinite(v)) throw new Error('Invalid POSIX baseline: non-finite count');
    }
  }
  return parsed;
}

function parseTypecheckStage(raw: string): TypecheckBaseline | null {
  if (!raw.trim()) return null;
  const parsed = JSON.parse(raw) as TypecheckBaseline;
  if (!Number.isFinite(parsed.errors)) throw new Error('Invalid typecheck baseline: errors must be a finite number');
  return parsed;
}

/** Scans both the working tree and the staged index for leftover conflict markers. Changed files are found with --diff-filter=ACMR. */
function assertCodeResolved(root: string, unmerged: string[]): void {
  const unresolved = unmerged.filter((file) => !GENERATED_PATHS.has(file));
  // Invariant: match marker lines, not inline fixture strings or // ===== dividers.
  const markerRe = /^(?:<{7}|>{7})(?: |\r?$)/m;
  // Working-tree scan: catches markers not yet staged.
  const wtChanged = paths(root, ['diff', 'HEAD', '--name-only', '--diff-filter=ACMR']);
  for (const file of wtChanged) {
    if (GENERATED_PATHS.has(file) || unresolved.includes(file)) continue;
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (!text.includes('\0') && markerRe.test(text)) unresolved.push(file);
  }
  // Staged scan: catches markers that were staged but not fixed in the working tree.
  const stagedChanged = paths(root, ['diff', '--cached', 'HEAD', '--name-only', '--diff-filter=ACMR']);
  for (const file of stagedChanged) {
    if (GENERATED_PATHS.has(file) || unresolved.includes(file)) continue;
    const text = git(root, ['show', `:0:${file}`]);
    if (!text.includes('\0') && markerRe.test(text)) unresolved.push(file);
  }
  if (unresolved.length) {
    throw new Error(`Resolve code conflicts first, then re-run regen:generated:\n${unresolved.map((p) => `  ${p}`).join('\n')}`);
  }
}

function unionConflicts(root: string, unmerged: string[]): number {
  let count = 0;
  for (const file of unmerged) {
    let serialized: string;
    if (file === '.filesize-baseline.json' || file === '.funcsize-baseline.json') {
      serialized = serializeBaseline(unionBaselines(
        parseBaseline(readStage(root, 2, file)), parseBaseline(readStage(root, 3, file)),
      ));
    } else if (file === '.posix-guard-baseline.json') {
      serialized = serializePosixBaseline(unionPosix(
        parsePosixStage(readStage(root, 2, file)), parsePosixStage(readStage(root, 3, file)),
      ));
    } else if (file === '.test-typecheck-baseline.json') {
      serialized = JSON.stringify(unionTypecheck(
        parseTypecheckStage(readStage(root, 2, file)), parseTypecheckStage(readStage(root, 3, file)),
      )) + '\n';
    } else continue; // Registry renders do not read their previous outputs.
    fs.writeFileSync(path.join(root, file), serialized);
    count++;
  }
  return count;
}

// Contract: these are the existing package.json update scripts, executed through
// Node + tsx to avoid shell quoting and Windows .cmd execution differences.
// `growth` marks ratchets that accept --allow-growth/--reason; renders never do.
// Renders write without parsing their previous output, so conflict markers are harmless.
const REGENERATORS: readonly { name: string; script: string; args: readonly string[]; growth: boolean }[] = [
  { name: 'audit:filesize:update', script: 'check-file-size.ts', args: ['--update-baseline'], growth: true },
  { name: 'audit:funcsize:update', script: 'check-function-size.ts', args: ['--update-baseline'], growth: true },
  { name: 'scan:env', script: 'render-env-registry.ts', args: [], growth: false },
  { name: 'scan:cli', script: 'lib/isolated-reference.ts', args: ['cli'], growth: false },
  { name: 'scan:slash', script: 'lib/isolated-reference.ts', args: ['slash'], growth: false },
  { name: 'scan:config', script: 'lib/isolated-reference.ts', args: ['config'], growth: false },
  { name: 'scan:surface', script: 'lib/isolated-reference.ts', args: ['surface'], growth: false },
  { name: 'audit:posix:update', script: 'check-posix-guard.ts', args: ['--update-baseline'], growth: true },
  { name: 'lint:tests:update', script: 'check-test-typecheck.ts', args: ['--update'], growth: true },
];

export function main(argv = process.argv.slice(2), cwd = process.cwd()): void {
  const parsed = parseGrowthArgs(argv, ['--allow-growth', '--reason']);
  if ('error' in parsed) throw new Error(parsed.error);
  const root = git(cwd, ['rev-parse', '--show-toplevel']).trim();
  const unmerged = paths(root, ['diff', '--name-only', '--diff-filter=U']);
  assertCodeResolved(root, unmerged);
  // Invariant: inspect every code conflict BEFORE writing any baseline union.
  const unions = unionConflicts(root, unmerged);
  const growth = parsed.allowGrowth ? ['--allow-growth', '--reason', parsed.reason] : [];
  for (const { name, script, args, growth: ratchet } of REGENERATORS) {
    console.log(`→ pnpm ${name}`);
    const result = spawnSync(process.execPath, [
      '--import', import.meta.resolve('tsx'), path.join(root, 'scripts', script),
      ...args, ...(ratchet ? growth : []),
    ], { cwd: root, stdio: 'inherit' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${name} failed (${result.signal ?? result.status}); generated files were not staged.`);
  }
  const changed = new Set([
    ...unmerged,
    ...paths(root, ['diff', '--name-only']),
    ...paths(root, ['diff', '--cached', '--name-only']),
    ...paths(root, ['ls-files', '--others', '--exclude-standard']),
  ]);
  const stage = [...GENERATED_PATHS].filter((file) => changed.has(file));
  if (stage.length) git(root, ['add', '-A', '--', ...stage]);
  const mergedRatchets = unmerged.filter((f) => GENERATED_PATHS.has(f));
  console.log(`✓ regen:generated: ${unmerged.length} conflict(s), ${unions} ratchet union(s); regenerated all artifacts.`);
  if (mergedRatchets.length) console.log(`  Merged ratchets: ${mergedRatchets.join(', ')}`);
  console.log(`  Staged ${stage.length} generated file(s)${stage.length ? `: ${stage.join(', ')}` : '.'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(`✗ regen:generated: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
