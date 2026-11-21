import { readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? files(file) :
      entry.name.endsWith('.ts') && !/\.(test|spec|d)\.ts$/.test(entry.name) &&
      !file.includes(`${path.sep}__test-utils__${path.sep}`) ? [file] : [];
  });
}

// Full directory enumeration, cheap text prefilter, AST only for candidate files.
// Constructor/import aliases and namespace property access survive formatting.
export function productionSites(src: string): string[] {
  return files(src).flatMap((file) => {
    const text = readFileSync(file, 'utf8');
    if (!/AgentSession|wireExecutors/.test(text)) return [];
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const names = new Map([['AgentSession', 'AgentSession'], ['wireExecutors', 'wireExecutors']]);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement)) continue;
      const bindings = statement.importClause?.namedBindings;
      if (!bindings || !ts.isNamedImports(bindings)) continue;
      for (const binding of bindings.elements) {
        const original = (binding.propertyName ?? binding.name).text;
        if (names.has(original)) names.set(binding.name.text, original);
      }
    }
    function resolved(expression: ts.Expression): string | undefined {
      return ts.isIdentifier(expression) ? names.get(expression.text) :
        ts.isPropertyAccessExpression(expression) ? names.get(expression.name.text) : undefined;
    }
    // Resolve local const aliases and destructuring too, without a whole-repo
    // typechecker. Repeat to a fixed point for alias chains in any source order.
    let changed = true;
    while (changed) {
      changed = false;
      function aliases(node: ts.Node): void {
        if (ts.isVariableDeclaration(node) && node.initializer) {
          if (ts.isIdentifier(node.name)) {
            const name = resolved(node.initializer);
            if (name && !names.has(node.name.text)) { names.set(node.name.text, name); changed = true; }
          } else if (ts.isObjectBindingPattern(node.name)) {
            for (const binding of node.name.elements) {
              const name = names.get((binding.propertyName ?? binding.name).getText(source));
              if (name && ts.isIdentifier(binding.name) && !names.has(binding.name.text)) {
                names.set(binding.name.text, name); changed = true;
              }
            }
          }
        }
        ts.forEachChild(node, aliases);
      }
      aliases(source);
    }
    const found: string[] = [];
    function visit(node: ts.Node): void {
      if (ts.isNewExpression(node) || ts.isCallExpression(node)) {
        const expression = node.expression;
        const name = ts.isIdentifier(expression) ? names.get(expression.text) :
          ts.isPropertyAccessExpression(expression) ? names.get(expression.name.text) : undefined;
        if (name && ((name === 'AgentSession' && ts.isNewExpression(node)) ||
          (name === 'wireExecutors' && ts.isCallExpression(node)))) {
          found.push(`${path.relative(src, file).split(path.sep).join('/')}:${name}`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    return found;
  }).sort();
}

// Non-surface constructor sites are named, never hidden behind directory skips.
// These are outside the six-surface capability comparison, not parity claims.
export const exemptions = {
  'agent/query.ts': 'SDK wrapper: caller supplies its own AgentConfig (createSession).',
  'agent/session/create-wired-executors.ts': 'SDK executor bundle; caller owns session construction.',
  'agent/subagent/fork-model-fallback.ts': 'Child fallback reconstruction, not a top-level surface.',
  'agent/subagent/fork-wiring.ts': 'Child session fork, inherits parent-config policy.',
  'cli/commands/status.ts': 'Connectivity probe: creates then closes without sending a message (source comment).',
};
