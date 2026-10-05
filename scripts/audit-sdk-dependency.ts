#!/usr/bin/env tsx
// Scans agent-afk source + tests for imports from tracked Anthropic packages,
// classifies each symbol as type-only vs runtime, counts runtime call sites,
// and emits:
//   - docs/sdk-dependency.md            (human snapshot, overwritten)
//   - <telemetry>/sdk-dependency-telemetry.jsonl (append-only)
//   - .sdk-dependency.lock.json         (allowlist with per-symbol rationale)
//
// Modes:
//   (default)       extract + write snapshot + append telemetry + warn on mismatch
//   --check         extract + exit nonzero if lock mismatch (CI / pre-commit)
//   --update-lock   extract + rewrite lock (preserves existing rationales)

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';

// Re-export types so importers of this module remain unchanged.
export type {
  TrackedPackage,
  ImportKind,
  SymbolUsage,
  LockEntry,
  LockFile,
  TelemetryEntry,
  Diff,
  Inventory,
} from './audit-sdk-dependency.types.js';

export { buildInventory } from './audit-sdk-dependency.scan.js';
export { readLock, writeLock, diffAgainstLock, diffIsBlocking, describeDiff } from './audit-sdk-dependency.lock.js';
export { renderSnapshot, buildTelemetry, appendTelemetry } from './audit-sdk-dependency.render.js';

import { buildInventory } from './audit-sdk-dependency.scan.js';
import { readLock, writeLock, diffAgainstLock, diffIsBlocking, describeDiff } from './audit-sdk-dependency.lock.js';
import { renderSnapshot, buildTelemetry, appendTelemetry } from './audit-sdk-dependency.render.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const SNAPSHOT_PATH = path.join(repoRoot, 'docs', 'sdk-dependency.md');
const LOCK_PATH = path.join(repoRoot, '.sdk-dependency.lock.json');

function readPackageVersions(): { sdk: string | null } {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const deps = pkgJson.dependencies ?? {};
  return {
    sdk: deps['@anthropic-ai/sdk'] ?? null,
  };
}

function main(argv: string[]): number {
  const mode: 'default' | 'check' | 'update-lock' = argv.includes('--check')
    ? 'check'
    : argv.includes('--update-lock')
      ? 'update-lock'
      : 'default';

  const inventory = buildInventory(repoRoot);
  const versions = readPackageVersions();
  const lock = readLock(LOCK_PATH);
  const diff = diffAgainstLock(inventory, lock);

  if (mode === 'check') {
    if (!lock) {
      console.error('audit:sdk --check: no lock file exists. Run `pnpm audit:sdk:update-lock` first.');
      return 2;
    }
    if (diffIsBlocking(diff)) {
      console.error('audit:sdk --check FAILED:');
      for (const line of describeDiff(diff)) console.error(line);
      console.error('');
      console.error('To accept: run `pnpm audit:sdk:update-lock`, then edit');
      console.error(`  ${path.relative(process.cwd(), LOCK_PATH)} to fill in the reason.`);
      return 1;
    }
    if (diff.dropped.length > 0) {
      console.log('audit:sdk --check: passed (with stale lock entries):');
      for (const d of diff.dropped) console.log(`  - DROP  ${d.package} :: ${d.symbol}`);
      console.log('Consider `pnpm audit:sdk:update-lock` to prune.');
    } else {
      console.log('audit:sdk --check: OK. Lock matches current imports.');
    }
    return 0;
  }

  fs.mkdirSync(path.dirname(SNAPSHOT_PATH), { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, renderSnapshot(inventory, versions), 'utf8');

  if (mode === 'update-lock') {
    writeLock(inventory, LOCK_PATH, lock);
    console.log(`audit:sdk: snapshot written \u2192 ${path.relative(process.cwd(), SNAPSHOT_PATH)}`);
    console.log(`audit:sdk: lock written     \u2192 ${path.relative(process.cwd(), LOCK_PATH)}`);
    if (diff.added.length > 0) {
      console.log('');
      console.log('New symbols added to lock (fill in reasons):');
      for (const a of diff.added) console.log(`  + ${a.package} :: ${a.symbol}`);
    }
    return 0;
  }

  const telemetry = buildTelemetry(inventory, diff, versions);
  appendTelemetry(telemetry);

  console.log(`audit:sdk: snapshot written \u2192 ${path.relative(process.cwd(), SNAPSHOT_PATH)}`);
  console.log(`audit:sdk: telemetry appended \u2192 ${path.join(os.homedir(), '.afk', 'agent-framework', 'sdk-dependency-telemetry.jsonl')}`);

  if (diffIsBlocking(diff) || diff.dropped.length > 0) {
    console.log('');
    console.log('Differences from lock (advisory \u2014 run `--check` for CI enforcement):');
    for (const line of describeDiff(diff)) console.log(line);
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
