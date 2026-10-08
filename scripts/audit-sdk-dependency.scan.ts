// Scanner concern: walk source trees and collect per-file SDK import records.

import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';
import type { TrackedPackage, ImportKind, SymbolUsage, Inventory } from './audit-sdk-dependency.types.js';
import { TRACKED_PACKAGES, SCAN_ROOTS } from './audit-sdk-dependency.types.js';
import { isAnyTs, walkSourceFiles } from './lib/walk-source-files.js';

export { TRACKED_PACKAGES, SCAN_ROOTS };

export function walk(dir: string, out: string[]): void {
  walkSourceFiles(dir, (absPath) => isAnyTs(absPath), out);
}

function isTracked(moduleSpecifier: string): moduleSpecifier is TrackedPackage {
  return (TRACKED_PACKAGES as readonly string[]).includes(moduleSpecifier);
}

export function collectImports(file: string, source: string, inventory: Inventory, repoRoot: string): void {
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
      usage = { kind: imp.kind, files: new Set(), callSites: 0 } satisfies SymbolUsage;
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

export function buildInventory(repoRoot: string): Inventory {
  const inventory: Inventory = new Map();
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(path.join(repoRoot, root), files);
  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');
    collectImports(file, src, inventory, repoRoot);
  }
  return inventory;
}
