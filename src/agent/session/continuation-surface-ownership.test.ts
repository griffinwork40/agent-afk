import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const src = fileURLToPath(new URL('../../', import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(file) :
      entry.name.endsWith('.ts') && !/\.(test|spec|d)\.ts$/.test(entry.name) ? [file] : [];
  });
}

function parse(relative: string): ts.SourceFile {
  const file = path.join(src, relative);
  return ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
}

function calls(source: ts.SourceFile, name: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === name) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

interface Ownership {
  owner?: string;
  registry: string;
  reason?: string;
}

const ownership: Record<string, Ownership> = {
  'agent/session/create-wired-executors.ts': { registry: 'wired.continuationRegistry' },
  'cli/commands/chat.session-setup.ts': { registry: 'continuationRegistry' },
  'cli/commands/acp.session.ts': { registry: 'continuationRegistry' },
  'cli/commands/daemon-session-factory.ts': { registry: 'continuationRegistry' },
  'web-server/session-owner.wiring.ts': { registry: 'executors.continuationRegistry' },
  'telegram/wire-telegram-executors.ts': { registry: 'executors.continuationRegistry' },
  'cli/commands/interactive/bootstrap-infra.ts': {
    owner: 'cli/commands/interactive/bootstrap.ts',
    registry: 'continuationRegistry',
    reason: 'Infrastructure builder transfers the registry to bootstrap, which owns session shutdown.',
  },
};

describe('wireExecutors continuation registry ownership', () => {
  it('accounts for every production call, excluding comments and tests', () => {
    const callers = sourceFiles(src).flatMap((file) => {
      const relative = path.relative(src, file).split(path.sep).join('/');
      return calls(parse(relative), 'wireExecutors').map(() => relative);
    });
    expect(callers.sort()).toEqual(Object.keys(ownership).sort());
  });

  for (const [caller, policy] of Object.entries(ownership)) {
    it(`${caller} passes its registry to session-end disposal`, () => {
      const source = parse(caller);
      const call = calls(source, 'wireExecutors')[0];
      expect(call).toBeDefined();
      if (call === undefined) return;
      const declaration = call.parent;
      expect(ts.isVariableDeclaration(declaration)).toBe(true);
      if (!ts.isVariableDeclaration(declaration)) return;
      if (ts.isObjectBindingPattern(declaration.name)) {
        expect(declaration.name.elements.some((element) => element.name.getText(source) === 'continuationRegistry')).toBe(true);
      } else {
        expect(policy.registry.startsWith(`${declaration.name.getText(source)}.`)).toBe(true);
      }
      const owner = policy.owner === undefined ? source : parse(policy.owner);
      if (policy.owner !== undefined) {
        expect(policy.reason).toBeTruthy();
        // This sole forwarding exemption must actually return the registry.
        expect(source.text).toMatch(/return\s*\{[^}]*\bcontinuationRegistry\b/s);
      }
      const disposals = [...calls(owner, 'withContinuationDispose'), ...calls(owner, 'drainThenDispose')];
      expect(disposals.some((dispose) => dispose.arguments[1]?.getText(owner) === policy.registry)).toBe(true);
    });
  }
});
