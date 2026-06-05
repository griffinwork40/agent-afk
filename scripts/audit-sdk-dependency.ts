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
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const TRACKED_PACKAGES = ['@anthropic-ai/sdk'] as const;
type TrackedPackage = (typeof TRACKED_PACKAGES)[number];

const SCAN_ROOTS = ['src', 'tests'];

const SNAPSHOT_PATH = path.join(repoRoot, 'docs', 'sdk-dependency.md');
const LOCK_PATH = path.join(repoRoot, '.sdk-dependency.lock.json');

const TELEMETRY_DIR = path.join(
  os.homedir(),
  '.afk',
  'agent-framework',
);
const TELEMETRY_PATH = path.join(TELEMETRY_DIR, 'sdk-dependency-telemetry.jsonl');

type ImportKind = 'type-only' | 'runtime';

interface SymbolUsage {
  kind: ImportKind;
  files: Set<string>;
  callSites: number;
}

interface LockEntry {
  kind: ImportKind;
  reason: string;
}

interface LockFile {
  generated_at: string;
  symbols: Record<string, Record<string, LockEntry>>;
}

interface TelemetryEntry {
  timestamp: string;
  surface: 'afk';
  sdk_version: string | null;
  total_files: number;
  per_package: Record<
    string,
    {
      files: number;
      runtime_symbols: number;
      type_only_symbols: number;
    }
  >;
  symbol_hash: string;
  new_symbols_since_last_run: Array<{ package: string; symbol: string; kind: ImportKind }>;
  dropped_symbols_since_last_run: Array<{ package: string; symbol: string }>;
  kind_changes_since_last_run: Array<{
    package: string;
    symbol: string;
    from: ImportKind;
    to: ImportKind;
  }>;
}

type Inventory = Map<TrackedPackage, Map<string, SymbolUsage>>;

function walk(dir: string, out: string[]): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      walk(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.ts')) {
      out.push(full);
    }
  }
}

function isTracked(moduleSpecifier: string): moduleSpecifier is TrackedPackage {
  return (TRACKED_PACKAGES as readonly string[]).includes(moduleSpecifier);
}

function collectImports(file: string, source: string, inventory: Inventory): void {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const rel = path.relative(repoRoot, file);

  interface PendingImport {
    pkg: TrackedPackage;
    symbol: string;
    kind: ImportKind;
  }
  const pending: PendingImport[] = [];

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt)) continue;
    const mod = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(mod)) continue;
    if (!isTracked(mod.text)) continue;
    const pkg = mod.text;

    const clause = stmt.importClause;
    if (!clause) continue;

    const wholeIsTypeOnly = clause.isTypeOnly === true;

    if (clause.name) {
      pending.push({
        pkg,
        symbol: `default as ${clause.name.text}`,
        kind: wholeIsTypeOnly ? 'type-only' : 'runtime',
      });
    }

    const bindings = clause.namedBindings;
    if (bindings) {
      if (ts.isNamespaceImport(bindings)) {
        pending.push({
          pkg,
          symbol: `* as ${bindings.name.text}`,
          kind: wholeIsTypeOnly ? 'type-only' : 'runtime',
        });
      } else {
        for (const el of bindings.elements) {
          const name = (el.propertyName ?? el.name).text;
          const elementTypeOnly = el.isTypeOnly === true;
          const kind: ImportKind = wholeIsTypeOnly || elementTypeOnly ? 'type-only' : 'runtime';
          pending.push({ pkg, symbol: name, kind });
        }
      }
    }
  }

  for (const imp of pending) {
    let pkgMap = inventory.get(imp.pkg);
    if (!pkgMap) {
      pkgMap = new Map();
      inventory.set(imp.pkg, pkgMap);
    }
    let usage = pkgMap.get(imp.symbol);
    if (!usage) {
      usage = { kind: imp.kind, files: new Set(), callSites: 0 };
      pkgMap.set(imp.symbol, usage);
    }
    usage.files.add(rel);
    if (imp.kind === 'runtime' && usage.kind === 'type-only') {
      usage.kind = 'runtime';
    }
    if (imp.kind === 'runtime') {
      const bare = imp.symbol.startsWith('default as ')
        ? imp.symbol.slice('default as '.length)
        : imp.symbol.startsWith('* as ')
          ? imp.symbol.slice('* as '.length)
          : imp.symbol;
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(bare)) {
        const re = new RegExp(`\\b${bare}\\s*\\(`, 'g');
        const m = source.match(re);
        usage.callSites += m ? m.length : 0;
      }
    }
  }
}

function buildInventory(): Inventory {
  const inventory: Inventory = new Map();
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(path.join(repoRoot, root), files);
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    collectImports(file, src, inventory);
  }
  return inventory;
}

function readPackageVersions(): { sdk: string | null } {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  const deps = pkgJson.dependencies ?? {};
  return {
    sdk: deps['@anthropic-ai/sdk'] ?? null,
  };
}

function readLock(): LockFile | null {
  if (!fs.existsSync(LOCK_PATH)) return null;
  return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8')) as LockFile;
}

function serializeSymbolSet(inventory: Inventory): string {
  const flat: Array<[string, string, ImportKind]> = [];
  for (const [pkg, syms] of inventory) {
    for (const [sym, usage] of syms) {
      flat.push([pkg, sym, usage.kind]);
    }
  }
  flat.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return flat.map((t) => t.join('|')).join('\n');
}

function hashSymbolSet(inventory: Inventory): string {
  const h = crypto.createHash('sha256');
  h.update(serializeSymbolSet(inventory));
  return `sha256:${h.digest('hex')}`;
}

interface Diff {
  added: Array<{ package: string; symbol: string; kind: ImportKind }>;
  dropped: Array<{ package: string; symbol: string }>;
  kindChanges: Array<{ package: string; symbol: string; from: ImportKind; to: ImportKind }>;
}

function diffAgainstLock(inventory: Inventory, lock: LockFile | null): Diff {
  const diff: Diff = { added: [], dropped: [], kindChanges: [] };
  const lockSymbols = lock?.symbols ?? {};

  for (const [pkg, syms] of inventory) {
    const lockPkg = lockSymbols[pkg] ?? {};
    for (const [sym, usage] of syms) {
      const lockEntry = lockPkg[sym];
      if (!lockEntry) {
        diff.added.push({ package: pkg, symbol: sym, kind: usage.kind });
      } else if (lockEntry.kind !== usage.kind) {
        diff.kindChanges.push({ package: pkg, symbol: sym, from: lockEntry.kind, to: usage.kind });
      }
    }
  }

  for (const [pkg, syms] of Object.entries(lockSymbols)) {
    const invPkg = inventory.get(pkg as TrackedPackage);
    for (const sym of Object.keys(syms)) {
      if (!invPkg || !invPkg.has(sym)) {
        diff.dropped.push({ package: pkg, symbol: sym });
      }
    }
  }

  return diff;
}

function writeLock(inventory: Inventory, previous: LockFile | null): void {
  const prev = previous?.symbols ?? {};
  const next: LockFile['symbols'] = {};

  for (const [pkg, syms] of inventory) {
    const prevPkg = prev[pkg] ?? {};
    const out: Record<string, LockEntry> = {};
    const sorted = [...syms.keys()].sort();
    for (const sym of sorted) {
      const usage = syms.get(sym)!;
      const prior = prevPkg[sym];
      const reason =
        prior && prior.reason.trim().length > 0
          ? prior.reason
          : `TODO: document why ${sym} is needed`;
      out[sym] = { kind: usage.kind, reason };
    }
    next[pkg] = out;
  }

  const body: LockFile = {
    generated_at: new Date().toISOString(),
    symbols: next,
  };

  for (const [pkg, syms] of Object.entries(body.symbols)) {
    for (const [sym, entry] of Object.entries(syms)) {
      if (!entry.reason || entry.reason.trim().length === 0) {
        throw new Error(
          `Refusing to write lock: empty reason for ${pkg}::${sym}. Fill in a rationale before writing.`,
        );
      }
    }
  }

  fs.writeFileSync(LOCK_PATH, JSON.stringify(body, null, 2) + '\n', 'utf8');
}

function renderSnapshot(inventory: Inventory, versions: { sdk: string | null }): string {
  const now = new Date().toISOString();
  const lines: string[] = [];
  lines.push('# SDK Dependency Snapshot');
  lines.push('');
  lines.push(`Generated: ${now}`);
  lines.push('');
  lines.push('## Versions');
  lines.push('');
  lines.push(`- \`@anthropic-ai/sdk\`: ${versions.sdk ?? '(not a dependency)'}`);
  lines.push('');

  const totalFiles = new Set<string>();
  for (const syms of inventory.values()) {
    for (const usage of syms.values()) {
      for (const f of usage.files) totalFiles.add(f);
    }
  }

  let totalRuntime = 0;
  let totalTypeOnly = 0;
  for (const syms of inventory.values()) {
    for (const usage of syms.values()) {
      if (usage.kind === 'runtime') totalRuntime += 1;
      else totalTypeOnly += 1;
    }
  }

  lines.push('## Summary');
  lines.push('');
  lines.push(`- **${totalFiles.size}** files import tracked Anthropic packages`);
  lines.push(`- **${totalRuntime}** runtime symbols, **${totalTypeOnly}** type-only symbols`);
  lines.push('');

  for (const pkg of TRACKED_PACKAGES) {
    const syms = inventory.get(pkg);
    lines.push(`## \`${pkg}\``);
    lines.push('');
    if (!syms || syms.size === 0) {
      lines.push('_No imports._');
      lines.push('');
      continue;
    }

    const pkgFiles = new Set<string>();
    let rt = 0;
    let ty = 0;
    for (const usage of syms.values()) {
      for (const f of usage.files) pkgFiles.add(f);
      if (usage.kind === 'runtime') rt += 1;
      else ty += 1;
    }
    lines.push(`- ${pkgFiles.size} files, ${rt} runtime symbols, ${ty} type-only symbols`);
    lines.push('');

    lines.push('### Symbols');
    lines.push('');
    lines.push('| Symbol | Kind | Files | Call sites |');
    lines.push('|---|---|---:|---:|');
    const sorted = [...syms.entries()].sort(
      (a, b) => (a[1].kind === b[1].kind ? 0 : a[1].kind === 'runtime' ? -1 : 1) || a[0].localeCompare(b[0]),
    );
    for (const [sym, usage] of sorted) {
      const calls = usage.kind === 'runtime' ? String(usage.callSites) : '—';
      lines.push(`| \`${sym}\` | ${usage.kind} | ${usage.files.size} | ${calls} |`);
    }
    lines.push('');

    lines.push('### Files');
    lines.push('');
    const fileMap = new Map<string, Array<{ sym: string; kind: ImportKind }>>();
    for (const [sym, usage] of syms) {
      for (const f of usage.files) {
        let arr = fileMap.get(f);
        if (!arr) {
          arr = [];
          fileMap.set(f, arr);
        }
        arr.push({ sym, kind: usage.kind });
      }
    }
    const sortedFiles = [...fileMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    lines.push('| File | Symbols |');
    lines.push('|---|---|');
    for (const [f, items] of sortedFiles) {
      items.sort((a, b) => a.sym.localeCompare(b.sym));
      const rendered = items.map((i) => `\`${i.sym}\`${i.kind === 'type-only' ? ' (type)' : ''}`).join(', ');
      lines.push(`| \`${f}\` | ${rendered} |`);
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('This file is regenerated by `pnpm audit:sdk`. Do not edit by hand.');
  lines.push('See `.sdk-dependency.lock.json` for the rationale of each tracked symbol.');
  lines.push('');
  return lines.join('\n');
}

function buildTelemetry(
  inventory: Inventory,
  diff: Diff,
  versions: { sdk: string | null },
): TelemetryEntry {
  const totalFiles = new Set<string>();
  const perPackage: TelemetryEntry['per_package'] = {};
  for (const [pkg, syms] of inventory) {
    const pkgFiles = new Set<string>();
    let rt = 0;
    let ty = 0;
    for (const usage of syms.values()) {
      for (const f of usage.files) {
        pkgFiles.add(f);
        totalFiles.add(f);
      }
      if (usage.kind === 'runtime') rt += 1;
      else ty += 1;
    }
    perPackage[pkg] = { files: pkgFiles.size, runtime_symbols: rt, type_only_symbols: ty };
  }

  return {
    timestamp: new Date().toISOString(),
    surface: 'afk',
    sdk_version: versions.sdk,
    total_files: totalFiles.size,
    per_package: perPackage,
    symbol_hash: hashSymbolSet(inventory),
    new_symbols_since_last_run: diff.added,
    dropped_symbols_since_last_run: diff.dropped.map((d) => ({
      package: d.package,
      symbol: d.symbol,
    })),
    kind_changes_since_last_run: diff.kindChanges,
  };
}

function appendTelemetry(entry: TelemetryEntry): void {
  fs.mkdirSync(TELEMETRY_DIR, { recursive: true });
  fs.appendFileSync(TELEMETRY_PATH, JSON.stringify(entry) + '\n', 'utf8');
}

function describeDiff(diff: Diff): string[] {
  const out: string[] = [];
  for (const a of diff.added) {
    out.push(`  + NEW   ${a.package} :: ${a.symbol} (${a.kind})`);
  }
  for (const c of diff.kindChanges) {
    out.push(`  ~ KIND  ${c.package} :: ${c.symbol}  ${c.from} → ${c.to}`);
  }
  for (const d of diff.dropped) {
    out.push(`  - DROP  ${d.package} :: ${d.symbol}`);
  }
  return out;
}

function diffIsBlocking(diff: Diff): boolean {
  return diff.added.length > 0 || diff.kindChanges.length > 0;
}

function main(argv: string[]): number {
  const mode: 'default' | 'check' | 'update-lock' = argv.includes('--check')
    ? 'check'
    : argv.includes('--update-lock')
      ? 'update-lock'
      : 'default';

  const inventory = buildInventory();
  const versions = readPackageVersions();
  const lock = readLock();
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
    writeLock(inventory, lock);
    console.log(`audit:sdk: snapshot written → ${path.relative(process.cwd(), SNAPSHOT_PATH)}`);
    console.log(`audit:sdk: lock written     → ${path.relative(process.cwd(), LOCK_PATH)}`);
    if (diff.added.length > 0) {
      console.log('');
      console.log('New symbols added to lock (fill in reasons):');
      for (const a of diff.added) console.log(`  + ${a.package} :: ${a.symbol}`);
    }
    return 0;
  }

  const telemetry = buildTelemetry(inventory, diff, versions);
  appendTelemetry(telemetry);

  console.log(`audit:sdk: snapshot written → ${path.relative(process.cwd(), SNAPSHOT_PATH)}`);
  console.log(`audit:sdk: telemetry appended → ${TELEMETRY_PATH}`);

  if (diffIsBlocking(diff) || diff.dropped.length > 0) {
    console.log('');
    console.log('Differences from lock (advisory — run `--check` for CI enforcement):');
    for (const line of describeDiff(diff)) console.log(line);
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
