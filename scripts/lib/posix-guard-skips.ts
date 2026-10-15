/**
 * R4 of the POSIX-assumption guard: sites in test files that skip or gate a
 * test on the host platform, so a Windows break hides instead of failing.
 *
 * Contract: a site is counted when its condition is "platform-shaped", meaning
 * it mentions `process.platform`, `os.platform()`, a `'win32'` literal, or an
 * identifier that is either named like a Windows flag (`isWin32`, `IS_WINDOWS`,
 * `win32`) or is a same-file `const` whose initializer is itself
 * platform-shaped. Counted shapes:
 *   - `it|test|describe[.each...].skipIf(cond)` / `.runIf(cond)`
 *   - `cond ? it : it.skip` (either branch order)
 *   - `if (cond) return;` whose then-branch is ONLY a bare return (the
 *     early-return skip; a guarded block with other logic is not counted)
 * Non-platform gates (`skipIf(!IPV6_AVAILABLE)`, `skipIf(!SHOULD_RUN)`) are not
 * counted. `skipIf(process.platform !== 'darwin')` IS counted: it also hides the
 * test on Windows.
 */

import ts from 'typescript';

import type { Finding } from './posix-guard-rules.js';

const GATE_METHODS = new Set(['skipIf', 'runIf']);
const WIN_FLAG_RE = /^(is_?)?win(dows|32)?$/i;

/** Same-file `const x = <expr>` initializers, for resolving flag identifiers. */
function collectConstInitializers(sf: ts.SourceFile): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      out.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function isPlatformShaped(expr: ts.Node, consts: Map<string, ts.Expression>, depth = 0): boolean {
  if (depth > 4) return false;
  let hit = false;
  const visit = (node: ts.Node): void => {
    if (hit) return;
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'platform') hit = true;
    else if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && node.text === 'win32') hit = true;
    else if (ts.isIdentifier(node)) {
      if (WIN_FLAG_RE.test(node.text)) hit = true;
      else {
        const init = consts.get(node.text);
        if (init && isPlatformShaped(init, consts, depth + 1)) hit = true;
      }
    }
    if (!hit) ts.forEachChild(node, visit);
  };
  visit(expr);
  return hit;
}

/** `it.skipIf(...)`, `describe.each(x).skipIf(...)`, `test.concurrent.runIf(...)`. */
function isGateCall(node: ts.CallExpression): boolean {
  const callee = node.expression;
  return ts.isPropertyAccessExpression(callee) && GATE_METHODS.has(callee.name.text);
}

/** `it.skip` / `describe.skip` as a value (not called). */
function isSkipReference(node: ts.Expression): boolean {
  return ts.isPropertyAccessExpression(node) && node.name.text === 'skip';
}

function isBareReturnBranch(stmt: ts.Statement): boolean {
  if (ts.isReturnStatement(stmt)) return stmt.expression === undefined;
  return ts.isBlock(stmt) && stmt.statements.length === 1 && isBareReturnBranch(stmt.statements[0]!);
}

function siteLine(sf: ts.SourceFile, node: ts.Node): Finding {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const text = (sf.text.split(/\r?\n/)[line] ?? '').trim().slice(0, 140);
  return { rule: 'R4', line: line + 1, text };
}

/** Every platform-gated skip site in one parsed test file. */
export function findPlatformSkips(sf: ts.SourceFile): Finding[] {
  const consts = collectConstInitializers(sf);
  const out: Finding[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && isGateCall(node)) {
      const cond = node.arguments[0];
      if (cond && isPlatformShaped(cond, consts)) out.push(siteLine(sf, node));
    } else if (
      ts.isConditionalExpression(node) &&
      (isSkipReference(node.whenTrue) || isSkipReference(node.whenFalse)) &&
      isPlatformShaped(node.condition, consts)
    ) {
      out.push(siteLine(sf, node));
    } else if (
      ts.isIfStatement(node) &&
      !node.elseStatement &&
      isBareReturnBranch(node.thenStatement) &&
      isPlatformShaped(node.expression, consts)
    ) {
      out.push(siteLine(sf, node));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}
