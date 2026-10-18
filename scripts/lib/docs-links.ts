import { posix } from 'node:path';
import ts from 'typescript';

export interface Redirect { source: string; destination: string }

/** Normalize URL paths, not host filesystem paths. Anchors/queries are ignored. */
export function slug(path: string): string {
  const clean = decodeURIComponent(path.split(/[?#]/, 1)[0] ?? '').replace(/\.(mdx?|html)$/, '');
  return posix.normalize(`/${clean}`).replace(/\/index$/, '').replace(/\/$/, '') || '/';
}

/** Literal redirects only; reading next.config never executes the website build. */
export function parseRedirects(text: string): Redirect[] {
  const source = ts.createSourceFile('next.config.ts', text, ts.ScriptTarget.Latest, true);
  const redirects: Redirect[] = [];
  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node)) {
      const values = new Map<string, string>();
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.initializer)) continue;
        if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) values.set(property.name.text, property.initializer.text);
      }
      if (values.has('source') && values.has('destination')) redirects.push({ source: values.get('source')!, destination: values.get('destination')! });
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return redirects;
}

function redirectTarget(path: string, redirect: Redirect): string | undefined {
  // Next's catch-all legacy /docs/:path* redirect; other parameter shapes fail
  // closed rather than treating an arbitrary prefix as a valid documentation page.
  const marker = '/:path*';
  if (redirect.source.endsWith(marker)) {
    const prefix = redirect.source.slice(0, -marker.length);
    if (path !== prefix && !path.startsWith(`${prefix}/`)) return undefined;
    return redirect.destination.replace(':path*', path.slice(prefix.length).replace(/^\//, ''));
  }
  return slug(redirect.source) === path ? redirect.destination : undefined;
}

export function resolves(path: string, pages: ReadonlySet<string>, redirects: readonly Redirect[], seen = new Set<string>()): boolean {
  const target = slug(path);
  if (seen.has(target)) return false;
  seen.add(target);
  // Invariant: Next.js applies redirects before filesystem routes, in declaration
  // order. A broken first match cannot fall through to a page or later redirect.
  for (const redirect of redirects) {
    const destination = redirectTarget(target, redirect);
    if (destination !== undefined) {
      return !/^[a-z][a-z\d+.-]*:/i.test(destination) && resolves(destination, pages, redirects, seen);
    }
  }
  return pages.has(target);
}

/** Exclude fenced/inline code and comments, not links illustrated as examples.
 * Markdown destinations use balanced parentheses, including angle destinations.
 * JSX supports quoted and brace-wrapped string href attributes. Nonliteral hrefs
 * fail visibly because they cannot be verified statically.
 */
export function links(text: string): string[] {
  const body = text.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '')
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}|<!--[\s\S]*?-->/g, '')
    .replace(/(`+)(?!`)[\s\S]*?\1/g, '');
  const out: string[] = [];
  const definitions = new Map<string, string>();
  const referenceId = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();
  for (const match of body.matchAll(/^\s*\[([^\]]+)\]:\s*<?([^\s>]+)>?/gm)) {
    definitions.set(referenceId(match[1]!), match[2]!);
  }
  for (const match of body.matchAll(/(?<!!)\[([^\]\n]*)\]\(/g)) {
    let index = match.index + match[0].length;
    let depth = 1;
    let value = '';
    while (index < body.length && depth) {
      const char = body[index++]!;
      if (char === '\\') { value += body[index++] ?? ''; continue; }
      if (char === '(') depth++;
      if (char === ')') depth--;
      if (depth) value += char;
    }
    if (!depth) out.push(value.trim().replace(/^<([^>]+)>.*$/, '$1').replace(/\s+["'][\s\S]*$/, ''));
  }
  // Reference, collapsed reference, and shortcut links. Definitions are checked
  // only when used; an unused reference definition is not a rendered link.
  const withoutDefinitions = body.replace(/^\s*\[[^\]]+\]:[^\n]*$/gm, '');
  for (const match of withoutDefinitions.matchAll(/(?<!!|\\)\[([^\]\n]+)\](?:\[([^\]\n]*)\])?(?!\()/g)) {
    const id = referenceId(match[2] || match[1]!);
    const target = definitions.get(id);
    if (target) out.push(target);
  }
  for (const match of body.matchAll(/\bhref\s*=\s*(?:(["'])(.*?)\1|\{\s*(["'])(.*?)\3\s*\}|(\{[^}]*\}))/gs)) {
    out.push(match[2] ?? match[4] ?? `UNVERIFIABLE:${match[5]}`);
  }
  return out;
}

export function internalTarget(href: string, file: string): string | undefined {
  if (/^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(href)) return undefined;
  const target = href.startsWith('/') ? href : posix.join(posix.dirname(file), href);
  return slug(target);
}
