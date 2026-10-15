// Lock file concern: read, write, diff, and describe the .sdk-dependency.lock.json.

import * as fs from 'node:fs';
import * as crypto from 'node:crypto';
import type { ImportKind, Inventory, LockEntry, LockFile, Diff } from './audit-sdk-dependency.types.js';

export function serializeSymbolSet(inventory: Inventory): string {
  const flat: Array<[string, string, ImportKind]> = [];
  for (const [pkg, syms] of inventory) {
    for (const [sym, usage] of syms) {
      flat.push([pkg, sym, usage.kind]);
    }
  }
  flat.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));
  return flat.map((t) => t.join('|')).join('\n');
}

export function hashSymbolSet(inventory: Inventory): string {
  const h = crypto.createHash('sha256');
  h.update(serializeSymbolSet(inventory));
  return `sha256:${h.digest('hex')}`;
}

export function readLock(lockPath: string): LockFile | null {
  if (!fs.existsSync(lockPath)) return null;
  return JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockFile;
}

export function diffAgainstLock(inventory: Inventory, lock: LockFile | null): Diff {
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
    const invPkg = inventory.get(pkg as Parameters<typeof inventory.get>[0]);
    for (const sym of Object.keys(syms)) {
      if (!invPkg || !invPkg.has(sym)) {
        diff.dropped.push({ package: pkg, symbol: sym });
      }
    }
  }

  return diff;
}

export function writeLock(inventory: Inventory, lockPath: string, previous: LockFile | null): void {
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

  fs.writeFileSync(lockPath, JSON.stringify(body, null, 2) + '\n', 'utf8');
}

export function describeDiff(diff: Diff): string[] {
  const out: string[] = [];
  for (const a of diff.added) {
    out.push(`  + NEW   ${a.package} :: ${a.symbol} (${a.kind})`);
  }
  for (const c of diff.kindChanges) {
    out.push(`  ~ KIND  ${c.package} :: ${c.symbol}  ${c.from} \u2192 ${c.to}`);
  }
  for (const d of diff.dropped) {
    out.push(`  - DROP  ${d.package} :: ${d.symbol}`);
  }
  return out;
}

export function diffIsBlocking(diff: Diff): boolean {
  return diff.added.length > 0 || diff.kindChanges.length > 0;
}
