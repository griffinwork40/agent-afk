/**
 * AST rules for the POSIX-assumption guard (`scripts/check-posix-guard.ts`,
 * enforced inside `pnpm test` by `tests/posix-guard.test.ts`).
 *
 * Invariant: every rule matches a SYNTACTIC shape that is wrong on Windows no
 * matter what the surrounding code does, so the false-positive rate stays near
 * zero. Rules match AST nodes, never raw text, so a violation spelled inside a
 * string, comment, or doc block (including this file and the fixture tests) is
 * never counted.
 *
 *   R1  a hardcoded POSIX shell binary as the command of execFile/spawn/exec
 *       (or `shell: '/bin/sh'` in an options object). Windows has no /bin/sh.
 *   R2  mkdtemp/mkdtempSync on a '/'-rooted literal ('/tmp/...'). /tmp does
 *       not exist on Windows.
 *   R3  host path.resolve/path.normalize on a '/'-rooted literal. On win32 the
 *       host resolver prepends the current drive: '/dev/null' -> 'C:\\dev\\null'
 *       (the #2588 bug in bash-scan-exempt.ts).
 *   R4  lives in `posix-guard-skips.ts` (win32-gated skip sites in tests).
 *
 * Contract: pure. `scanSource` takes text, returns findings, never touches fs.
 */

import ts from 'typescript';

import { findPlatformSkips } from './posix-guard-skips.js';

export type RuleId = 'R1' | 'R2' | 'R3' | 'R4';
export const RULE_IDS: readonly RuleId[] = ['R1', 'R2', 'R3', 'R4'];

export interface Finding {
  rule: RuleId;
  /** 1-based line of the offending node. */
  line: number;
  /** Trimmed source of the offending line, for messages. */
  text: string;
}

export const RULE_TITLES: Record<RuleId, string> = {
  R1: 'hardcoded POSIX shell binary',
  R2: "mkdtemp on a '/'-rooted literal",
  R3: "host path.resolve/normalize on a '/'-rooted literal",
  R4: 'test skipped/gated on platform (win32)',
};

/** What to do instead. Printed verbatim under every failure of the rule. */
export const RULE_FIXES: Record<RuleId, string> = {
  R1:
    "Windows has no /bin/sh. To run a command STRING use resolveShell() from src/utils/resolve-shell.ts " +
    '(spawn(cmd, { shell: r.shell }) / execFile(r.shell, [...r.args, cmd])); to run a real program, ' +
    'execFile the program itself with an args array instead of wrapping it in sh -c.',
  R2:
    "/tmp does not exist on Windows. Use fs.mkdtemp(path.join(os.tmpdir(), 'afk-<name>-')).",
  R3:
    "Host path.resolve('/x') returns 'C:\\\\x' on Windows. For POSIX-shaped paths ('/dev/null', '/tmp', " +
    'shell-scan candidates) use path.posix.resolve / path.posix.normalize; for real host paths build ' +
    'from os.tmpdir(), os.homedir(), or a resolved root rather than a / literal.',
  R4:
    'Never skip (or early-return) a test on win32. Make it portable: os.tmpdir() + path.join, ' +
    'resolveShell(), path.posix for POSIX-shaped fixtures, product fixes for real Windows bugs. If a ' +
    'test is genuinely POSIX-only by nature, raise it on #703 instead of adding a skip.',
};

const SHELL_BINARIES = new Set(['sh', 'bash', 'zsh', 'dash']);
const EXEC_CALLEES = new Set(['execFile', 'execFileSync', 'spawn', 'spawnSync', 'exec', 'execSync']);
const MKDTEMP_CALLEES = new Set(['mkdtemp', 'mkdtempSync']);
const HOST_RESOLVERS = new Set(['resolve', 'normalize']);
const PATH_MODULES = new Set(['path', 'node:path']);

/** Full text of a literal with no substitutions, else undefined. */
export function literalValue(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return undefined;
}

/** Leading constant text of a literal or template (`\`/tmp/${x}\`` -> '/tmp/'). */
export function literalPrefix(node: ts.Node | undefined): string | undefined {
  if (node && ts.isTemplateExpression(node)) return node.head.text;
  return literalValue(node);
}

/** `foo(...)` -> 'foo'; `a.b.foo(...)` -> 'foo'. */
export function calleeName(expr: ts.Expression): string | undefined {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  return undefined;
}

/** '/bin/sh', 'sh', '/usr/bin/env bash' style first token -> is it a POSIX shell? */
function isShellCommand(value: string): boolean {
  const tokens = value.trim().split(/\s+/);
  let first = tokens[0] ?? '';
  if (first === '/usr/bin/env' || first === 'env') first = tokens[1] ?? '';
  const base = first.includes('/') ? first.slice(first.lastIndexOf('/') + 1) : first;
  // A bare name ('sh') or an absolute POSIX path ('/bin/sh'); never a relative path.
  if (first.includes('/') && !first.startsWith('/')) return false;
  return SHELL_BINARIES.has(base);
}

interface HostPathBindings {
  /** Identifiers bound to the host `path` module (`import path from 'path'`). */
  namespaces: Set<string>;
  /** Local names bound to host `resolve`/`normalize` (`import { resolve as r }`). */
  functions: Set<string>;
}

function isPathModuleSpecifier(node: ts.Node | undefined): boolean {
  const v = literalValue(node);
  return v !== undefined && PATH_MODULES.has(v);
}

/** Collect host-path bindings from imports and `require('path')`. `path` is always one. */
function collectHostPathBindings(sf: ts.SourceFile): HostPathBindings {
  const b: HostPathBindings = { namespaces: new Set(['path']), functions: new Set() };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && isPathModuleSpecifier(node.moduleSpecifier)) {
      const clause = node.importClause;
      if (clause?.name) b.namespaces.add(clause.name.text);
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) b.namespaces.add(nb.name.text);
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) {
          const imported = (el.propertyName ?? el.name).text;
          if (HOST_RESOLVERS.has(imported)) b.functions.add(el.name.text);
        }
      }
    } else if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      calleeName(node.initializer.expression) === 'require' &&
      isPathModuleSpecifier(node.initializer.arguments[0])
    ) {
      if (ts.isIdentifier(node.name)) b.namespaces.add(node.name.text);
      else if (ts.isObjectBindingPattern(node.name)) {
        for (const el of node.name.elements) {
          const imported = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : undefined;
          if (ts.isIdentifier(el.name) && HOST_RESOLVERS.has(imported ?? el.name.text)) b.functions.add(el.name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return b;
}

/** Is this call a HOST `path.resolve`/`path.normalize` (not `path.posix.*` / `path.win32.*`)? */
function isHostResolverCall(call: ts.CallExpression, b: HostPathBindings): boolean {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return b.functions.has(callee.text);
  return (
    ts.isPropertyAccessExpression(callee) &&
    HOST_RESOLVERS.has(callee.name.text) &&
    ts.isIdentifier(callee.expression) &&
    b.namespaces.has(callee.expression.text)
  );
}

function checkCall(call: ts.CallExpression, bindings: HostPathBindings): RuleId | undefined {
  const name = calleeName(call.expression);
  const arg0 = call.arguments[0];
  if (name && EXEC_CALLEES.has(name)) {
    const v = literalValue(arg0);
    if (v !== undefined && isShellCommand(v)) return 'R1';
  }
  if (name && MKDTEMP_CALLEES.has(name)) {
    // Direct literal, or a literal-rooted join: mkdtemp(path.join('/tmp', 'x-')).
    const inner = arg0 && ts.isCallExpression(arg0) ? arg0.arguments[0] : undefined;
    if (literalPrefix(arg0)?.startsWith('/') || literalPrefix(inner)?.startsWith('/')) return 'R2';
  }
  if (isHostResolverCall(call, bindings) && call.arguments.some((a) => literalPrefix(a)?.startsWith('/'))) {
    return 'R3';
  }
  return undefined;
}

/** `{ shell: '/bin/sh' }` in an options object: the same bug as R1, spelled differently. */
function isShellOption(node: ts.Node): boolean {
  if (!ts.isPropertyAssignment(node)) return false;
  const key = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : undefined;
  const v = literalValue(node.initializer);
  return key === 'shell' && v !== undefined && v.startsWith('/') && isShellCommand(v);
}

export function finding(sf: ts.SourceFile, node: ts.Node, rule: RuleId): Finding {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
  const text = (sf.text.split(/\r?\n/)[line] ?? '').trim().slice(0, 140);
  return { rule, line: line + 1, text };
}

function scriptKind(fileName: string): ts.ScriptKind {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.[cm]?js$/.test(fileName)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/**
 * Scan one source text for the given rules.
 *
 * @param fileName - Used only for script-kind detection.
 * @param text - Source text.
 * @param rules - The rules in scope for this file (see `rulesFor`).
 */
export function scanSource(fileName: string, text: string, rules: readonly RuleId[]): Finding[] {
  const want = new Set(rules);
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, scriptKind(fileName));
  const out: Finding[] = [];
  const bindings = collectHostPathBindings(sf);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const rule = checkCall(node, bindings);
      if (rule && want.has(rule)) out.push(finding(sf, node, rule));
    } else if (want.has('R1') && isShellOption(node)) {
      out.push(finding(sf, node, 'R1'));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (want.has('R4')) out.push(...findPlatformSkips(sf));
  return out.sort((a, b) => a.line - b.line);
}
