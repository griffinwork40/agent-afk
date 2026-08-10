/**
 * Measure the line extent of every function in a source file, via the TypeScript
 * AST. Consumed by `scripts/check-function-size.ts`.
 *
 * Contract: three measurement decisions are load-bearing and each rules out a
 * simpler form.
 *
 * 1. OUTERMOST ONLY. A function nested inside another function is not measured
 *    separately; its lines are already counted against the declaration that
 *    encloses it. Measuring both would double-count — a 600-line function that is
 *    600 lines *because* of one 500-line callback would raise two violations for
 *    one problem, and fixing the inner one silently retires the outer. Attributing
 *    to the outermost declaration means every violation names a thing you can
 *    actually extract. Class members count as outermost: a class is not a function,
 *    so methods are measured individually (this is what makes `commitAbove` and
 *    `executeBatch` visible rather than hidden inside a class body).
 *
 * 2. JSDoc IS EXCLUDED. The extent starts at the declaration keyword, not at the
 *    leading comment block. This deliberately diverges from the FILE gate, which
 *    counts comments on purpose. The difference is whether a pressure valve
 *    exists: at file scope you relieve the ceiling by extracting a concern, and
 *    JSDoc travels with its declaration, so no documentation is ever lost. At
 *    function scope there is no such valve — a function cannot be split from its
 *    own doc comment — so counting JSDoc would create undiluted pressure to
 *    delete documentation, which AFK.md's long-comment convention forbids.
 *
 * 3. BODILESS DECLARATIONS ARE SKIPPED. Overload signatures and ambient
 *    declarations have no implementation to measure; counting them would emit
 *    1-line entries that can never violate and only bloat the baseline.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import ts from 'typescript';

export interface FunctionExtent {
  /** Qualified, file-stable name, e.g. `AgentSession.query` or `runTurn`. */
  name: string;
  /** Raw line count of the declaration, JSDoc excluded. */
  loc: number;
  /** 1-based line of the declaration keyword, for error messages. */
  line: number;
}

type FunctionLikeNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isFunctionLike(node: ts.Node): node is FunctionLikeNode {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function scriptKindFor(filePath: string): ts.ScriptKind {
  const ext = path.extname(filePath);
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** Name of the class/interface/object a member belongs to, or null at module scope. */
function enclosingTypeName(node: ts.Node): string | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isClassDeclaration(cur) || ts.isClassExpression(cur)) {
      return cur.name?.text ?? '<anonymous class>';
    }
    if (ts.isInterfaceDeclaration(cur)) return cur.name.text;
    cur = cur.parent;
  }
  return null;
}

function propertyKeyText(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  // Computed keys such as `[Symbol.asyncIterator]` — keep the bracketed source
  // text so the baseline key matches what a reader greps for.
  return name.getText();
}

/**
 * Resolve a stable, human-recognisable name.
 *
 * Invariant: the name must not embed a line number. Baseline keys are compared
 * across commits, and a key containing a line number would rotate on every edit
 * above it — every unrelated insertion would read as one STALE plus one NEW.
 */
function resolveName(node: FunctionLikeNode, anonymousOrdinal: () => number): string {
  const owner = enclosingTypeName(node);
  const qualify = (base: string): string => (owner ? `${owner}.${base}` : base);

  if (ts.isFunctionDeclaration(node)) return node.name?.text ?? `<default export#${anonymousOrdinal()}>`;
  if (ts.isConstructorDeclaration(node)) return qualify('constructor');
  if (ts.isMethodDeclaration(node)) return qualify(propertyKeyText(node.name));
  if (ts.isGetAccessorDeclaration(node)) return qualify(`get ${propertyKeyText(node.name)}`);
  if (ts.isSetAccessorDeclaration(node)) return qualify(`set ${propertyKeyText(node.name)}`);

  // Arrow functions and function expressions borrow the name of whatever binds them.
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyDeclaration(parent)) return qualify(propertyKeyText(parent.name));
  if (parent && ts.isPropertyAssignment(parent)) return qualify(propertyKeyText(parent.name));
  if (parent && ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const lhs = parent.left.getText();
    if (lhs.length > 0 && lhs.length <= 60) return lhs;
  }
  if (parent && ts.isExportAssignment(parent)) return '<default export>';
  return `<anonymous#${anonymousOrdinal()}>`;
}

function hasBody(node: FunctionLikeNode): boolean {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return true;
  return node.body !== undefined;
}

/**
 * Every outermost function in one file, measured. Returns an empty array for a
 * file the parser cannot make sense of rather than throwing — a gate must not be
 * the thing that breaks on an unparseable fixture.
 */
export function measureFile(absPath: string): FunctionExtent[] {
  let text: string;
  try {
    text = fs.readFileSync(absPath, 'utf8');
  } catch {
    return [];
  }

  const source = ts.createSourceFile(
    absPath,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    scriptKindFor(absPath),
  );

  const found: FunctionExtent[] = [];
  let anonymousCount = 0;
  const nextOrdinal = (): number => ++anonymousCount;

  const visit = (node: ts.Node, insideFunction: boolean): void => {
    if (isFunctionLike(node)) {
      if (!insideFunction && hasBody(node)) {
        // getStart(source) without `includeJsDocComment` starts at the declaration
        // keyword — see decision 2 in the module contract.
        const startLine = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
        const endLine = source.getLineAndCharacterOfPosition(node.getEnd()).line;
        found.push({
          name: resolveName(node, nextOrdinal),
          loc: endLine - startLine + 1,
          line: startLine + 1,
        });
      }
      ts.forEachChild(node, (child) => visit(child, true));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, insideFunction));
  };

  visit(source, false);
  return dedupeNames(found);
}

/**
 * Invariant: baseline keys must be unique per file. Two same-named outermost
 * functions are legal TypeScript (an overloaded class member pair across
 * declaration merging, two object literals with the same property name), so
 * disambiguate collisions by stable occurrence order rather than by line.
 */
function dedupeNames(extents: FunctionExtent[]): FunctionExtent[] {
  const seen = new Map<string, number>();
  return extents.map((e) => {
    const n = (seen.get(e.name) ?? 0) + 1;
    seen.set(e.name, n);
    return n === 1 ? e : { ...e, name: `${e.name}#${n}` };
  });
}

/** Compose the repo-wide key for one function: `<relative path>::<qualified name>`. */
export function functionKey(relPath: string, name: string): string {
  return `${relPath}::${name}`;
}

/** Split a key back into its parts. Returns null if the key is malformed. */
export function parseFunctionKey(key: string): { file: string; name: string } | null {
  const idx = key.indexOf('::');
  if (idx <= 0) return null;
  return { file: key.slice(0, idx), name: key.slice(idx + 2) };
}
