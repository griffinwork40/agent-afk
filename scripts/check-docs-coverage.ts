#!/usr/bin/env tsx
/** Coverage source derivation: parse production TypeScript under src/agent and
 * collect names of schema objects with BOTH name and input_schema properties.
 * This includes ALL_TOOL_SCHEMAS' individual schemas, memory, state, workspace,
 * awareness, peer, browser, and exit_plan_mode without importing their handlers.
 * Dynamic custom/MCP schemas have runtime names, so cannot be enumerated here;
 * they are extension APIs, not shipped model tool names. Spread-only schema
 * wrappers (agents/tool-def.ts) inherit an already counted name.
 * HarnessHookEvent is parsed from hooks.ts, not copied into a second list.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { isMain, repoRoot } from './lib/docs-reference.js';

/** No shipped static tools are exempt. Any future exemption needs a reason. */
export const UNDOCUMENTED_INTERNAL_TOOLS: Readonly<Record<string, string>> = {};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name.startsWith('__') ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

function propertyName(node: ts.PropertyName | undefined): string | undefined {
  return node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : undefined;
}

/** AST scan is side effect free, including schemas colocated with handlers. */
export function schemaNames(text: string, filename = 'schema.ts'): string[] {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true);
  const declarations = new Map<string, ts.Node[]>();
  const constants = new Map<string, ts.Expression>();
  const names = new Set<string>();
  function collectDeclarations(node: ts.Node): void {
    // Count bindings in every scope, including imports and destructuring. A local
    // shadow must never borrow the value of an unrelated top-level constant.
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node) || ts.isBindingElement(node)
      || ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)
      || ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node))
      && node.name && ts.isIdentifier(node.name)) {
      const entries = declarations.get(node.name.text) ?? [];
      entries.push(node);
      declarations.set(node.name.text, entries);
    }
    if (ts.isVariableStatement(node) && node.parent === source && (node.declarationList.flags & ts.NodeFlags.Const)) {
      for (const declaration of node.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          constants.set(declaration.name.text, declaration.initializer);
        }
      }
    }
    ts.forEachChild(node, collectDeclarations);
  }
  collectDeclarations(source);
  function literal(node: ts.Expression | undefined, seen = new Set<string>()): string | undefined {
    if (!node) return undefined;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
    if (!ts.isIdentifier(node) || seen.has(node.text) || declarations.get(node.text)?.length !== 1) return undefined;
    seen.add(node.text);
    return literal(constants.get(node.text), seen);
  }
  function visit(node: ts.Node): void {
    // The MCP wire adapter converts server-supplied schemas, not shipped tools.
    // Exempt only its direct return object; other schemas in this file still fail
    // closed. No unresolved identifier in the static tool universe is exempt.
    const parent = node.parent;
    const owner = parent?.parent?.parent;
    if (ts.isObjectLiteralExpression(node) && /(?:^|[/\\])src[/\\]agent[/\\]mcp[/\\]manager\.ts$/.test(filename)
      && parent && ts.isReturnStatement(parent) && owner && ts.isFunctionDeclaration(owner)
      && owner.name?.text === 'mcpToolToAnthropic') return;
    if (ts.isObjectLiteralExpression(node)) {
      const props = node.properties.filter(ts.isPropertyAssignment);
      if (props.some((prop) => propertyName(prop.name) === 'input_schema')) {
        const prop = props.find((item) => propertyName(item.name) === 'name');
        if (prop) {
          const name = literal(prop.initializer);
          if (name === undefined) {
            const line = source.getLineAndCharacterOfPosition(prop.getStart(source)).line + 1;
            throw new Error(`${filename}:${line}: cannot unambiguously resolve tool name ${prop.initializer.getText(source)}; expected a string literal or unique same-file top-level const`);
          }
          names.add(name);
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return [...names].sort();
}

export function hookEvents(text: string): string[] {
  const source = ts.createSourceFile('hooks.ts', text, ts.ScriptTarget.Latest, true);
  const declaration = source.statements.find((node): node is ts.TypeAliasDeclaration =>
    ts.isTypeAliasDeclaration(node) && node.name.text === 'HarnessHookEvent');
  if (!declaration || !ts.isUnionTypeNode(declaration.type)) throw new Error('HarnessHookEvent union not found');
  return declaration.type.types.map((node) => {
    if (!ts.isLiteralTypeNode(node) || !ts.isStringLiteral(node.literal)) throw new Error('Nonliteral HarnessHookEvent');
    return node.literal.text;
  }).sort();
}

export function collectCoverageNames(root: string): { tools: string[]; hooks: string[]; sources: string[] } {
  const sources = sourceFiles(join(root, 'src/agent'));
  const files = sources.map((path) => ({ path, names: schemaNames(readFileSync(path, 'utf8'), path) }));
  return {
    tools: [...new Set(files.flatMap((file) => file.names))].sort(),
    hooks: hookEvents(readFileSync(join(root, 'src/agent/hooks.ts'), 'utf8')),
    sources: files.filter((file) => file.names.length).map((file) => relative(root, file.path)).sort(),
  };
}

/** Exact inline-code tokens only; mentions in prose or fenced code do not pass. */
export function missingTokens(names: readonly string[], content: string): string[] {
  const text = content.replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}|<!--[\s\S]*?-->/g, '');
  const tokens = new Set([...text.matchAll(/(?<!`)`([^`\n]+)`(?!`)/g)].map((match) => match[1]));
  return names.filter((name) => !tokens.has(name));
}

export function checkCoverage(tools: readonly string[], hooks: readonly string[], toolPage: string, hookPage: string): string[] {
  return [
    ...missingTokens(tools.filter((name) => !(name in UNDOCUMENTED_INTERNAL_TOOLS)), toolPage).map((name) => `reference/tools: missing ${name}`),
    ...missingTokens(hooks, hookPage).map((name) => `reference/hooks: missing ${name}`),
  ];
}

if (isMain(import.meta.url)) {
  const names = collectCoverageNames(repoRoot);
  const page = (slug: string): string => {
    try { return readFileSync(join(repoRoot, `website/content/docs/reference/${slug}.mdx`), 'utf8'); }
    catch { return ''; }
  };
  const errors = checkCoverage(names.tools, names.hooks, page('tools'), page('hooks'));
  console.log(`Docs coverage: ${names.tools.length} tool names from ${names.sources.length} schema modules; ${names.hooks.length} hook events`);
  for (const error of errors) console.error(error);
  process.exitCode = errors.length ? 1 : 0;
}
