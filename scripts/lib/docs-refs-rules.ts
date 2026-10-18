/** Per-line reference rules for check-docs-refs. Pure functions over text. */
import { afkSegments, checkCommand, nearest, type RefFinding } from './docs-refs-command.js';
import type { KnownRefs } from './docs-refs-known.js';

export type { RefFinding } from './docs-refs-command.js';
export interface LineFinding extends RefFinding { line: number }

const SHELL_FENCES = /^(?:bash|sh|shell|zsh|fish|powershell|console|text)$/;
/** HTTP path segments that read like slash commands (`/v1`, `GET .../models`). */
const HTTP_PATH = /^\/(?:v\d+|models|completions|health)$/;
const FS_ROOTS = new Set(['/tmp', '/usr', '/etc', '/var', '/bin', '/opt', '/dev', '/home', '/Users', '/proc', '/mnt', '/sbin', '/lib', '/private', '/Volumes']);

/** Line numbers (1-based) excluded by docs-refs-ignore markers, read from raw text. */
export function ignoredLines(raw: string): Set<number> {
  const out = new Set<number>();
  let block = false;
  raw.split(/\r?\n/).forEach((line, index) => {
    const n = index + 1;
    if (/docs-refs-ignore-start/.test(line)) block = true;
    if (block) out.add(n);
    if (/docs-refs-ignore-end/.test(line)) block = false;
    if (/docs-refs-ignore-next-line/.test(line)) { out.add(n); out.add(n + 1); }
  });
  return out;
}

/** Env references, including patterns (`AFK_MODEL_<TIER>_BASE_URL`, `AFK_WORKTREE_*`). */
export function envFindings(line: string, known: KnownRefs): RefFinding[] {
  const text = line.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\\([<>{}*])/g, '$1');
  const findings: RefFinding[] = [];
  for (const match of text.matchAll(/(?<![A-Za-z0-9_])AFK_[A-Z0-9_]*(?:(?:<[^>\s]*>|\{[^}\s]*\}|\*)[A-Z0-9_]*)*/g)) {
    const token = match[0];
    const pattern = /[<{*]/.test(token) || token.endsWith('_');
    if (!pattern) {
      if (!known.env.has(token)) findings.push({ kind: 'env', token, suggestion: nearest(token, known.env, 4) });
      continue;
    }
    const source = token.split(/(<[^>]*>|\{[^}]*\}|\*)/).map((part) => {
      if (part.startsWith('<') || part === '*') return '[A-Z0-9_]+';
      if (part.startsWith('{')) return `(?:${part.slice(1, -1).split(/[,|]/).map(escape).join('|')})`;
      return escape(part);
    }).join('');
    const regex = new RegExp(`^${source}${token.endsWith('_') && !/[<{*]/.test(token) ? '[A-Z0-9_]+' : ''}$`);
    if (![...known.env].some((name) => regex.test(name))) findings.push({ kind: 'env-pattern', token });
  }
  return findings;
}
function escape(text: string): string { return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

export function slashFinding(span: string, known: KnownRefs): RefFinding | undefined {
  const word = span.trim().split(/\s+/)[0]!;
  if (!/^\/[A-Za-z][\w:-]*$/.test(word) || FS_ROOTS.has(word) || HTTP_PATH.test(word)) return undefined;
  if (known.slash.has(word)) return undefined;
  return { kind: 'slash', token: word, suggestion: nearest(word, known.slash, 2) };
}

export function configFinding(span: string, known: KnownRefs): RefFinding | undefined {
  const token = span.trim();
  const match = /^([A-Za-z]+)((?:\.[A-Za-z0-9_<>*-]*)+)$/.exec(token);
  if (!match || !known.configRoots.has(match[1]!)) return undefined;
  // `prefix.*` and `prefix.` mean "the keys under prefix".
  const parts = token.replace(/\.\*?$/, '').split('.');
  let resolves = false;
  for (let i = 0; i < parts.length && !resolves; i++) {
    const prefix = parts.slice(0, i + 1).join('.');
    // Map-style key reached: any child name is accepted below it.
    if (i < parts.length - 1 && known.config.has(prefix) && known.config.has(`${prefix}.*`)) resolves = true;
    else if (i === parts.length - 1) resolves = [...known.config].some((key) => key === prefix || key.startsWith(`${prefix}.`));
  }
  return resolves ? undefined : { kind: 'config', token, suggestion: nearest(token, [...known.config].filter((k) => !k.endsWith('*')), 6) };
}

/** "the `x` tool", "`X` hook", "`X` event" phrases name current tools/hooks. */
export function phraseFindings(line: string, known: KnownRefs): RefFinding[] {
  const findings: RefFinding[] = [];
  for (const m of line.matchAll(/`([a-z][a-z0-9_]*)` tool\b/g)) {
    if (!known.tools.has(m[1]!)) findings.push({ kind: 'tool', token: m[1]!, suggestion: nearest(m[1]!, known.tools, 3) });
  }
  for (const m of line.matchAll(/`([A-Z][A-Za-z]+)` (?:hook|event)s?\b/g)) {
    if (!known.hooks.has(m[1]!)) findings.push({ kind: 'hook', token: m[1]!, suggestion: nearest(m[1]!, known.hooks, 4) });
  }
  return findings;
}

/** Heading reverse checks for the two hand-written reference pages. */
export function headingFinding(page: string, line: string, known: KnownRefs): RefFinding | undefined {
  if (page.endsWith('reference/tools.mdx')) {
    const m = /^###\s+`([^`]+)`\s*$/.exec(line);
    if (m && !known.tools.has(m[1]!)) return { kind: 'tool', token: m[1]!, suggestion: nearest(m[1]!, known.tools, 3) };
  }
  if (page.endsWith('reference/hooks.mdx')) {
    const m = /^##\s+`([^`]+)`\s*$/.exec(line);
    if (m && !known.hooks.has(m[1]!)) return { kind: 'hook', token: m[1]!, suggestion: nearest(m[1]!, known.hooks, 4) };
  }
  return undefined;
}

function inlineSpans(line: string): string[] {
  return [...line.matchAll(/(?<!`)(`+)(?!`)(.*?[^`])\1(?!`)/g)].map((m) => m[2]!.trim());
}

/** All findings for one page. `text` must already have comments stripped
 * (line-preserving); `ignored` comes from the raw text. */
export function pageFindings(page: string, text: string, ignored: ReadonlySet<number>, known: KnownRefs): LineFinding[] {
  const out: LineFinding[] = [];
  const lines = text.split(/\r?\n/);
  let fence: { marker: string; shell: boolean } | undefined;
  let continued = '';
  let continuedAt = 0;
  lines.forEach((line, index) => {
    const n = index + 1;
    const add = (items: (RefFinding | undefined)[], at = n): void => {
      for (const item of items) if (item && !ignored.has(at)) out.push({ ...item, line: at });
    };
    add(envFindings(line, known));
    if (fence) {
      if (new RegExp(`^\\s*${fence.marker[0] === '`' ? '`' : '~'}{${fence.marker.length},}\\s*$`).test(line)) { fence = undefined; return; }
      if (!fence.shell) return;
      if (!continued) continuedAt = n;
      continued += line.replace(/\\\s*$/, ' ');
      if (/\\\s*$/.test(line)) return;
      for (const segment of afkSegments(continued)) add(checkCommand(segment, known), continuedAt);
      continued = '';
      return;
    }
    const opening = /^\s*(`{3,}|~{3,})\s*([^\s`{]*)/.exec(line);
    if (opening) { fence = { marker: opening[1]!, shell: SHELL_FENCES.test(opening[2]!) }; continued = ''; return; }
    add([headingFinding(page, line, known), ...phraseFindings(line, known)]);
    for (const span of inlineSpans(line)) {
      if (/^(?:\$\s+)?afk(?:\s|$)/.test(span)) for (const segment of afkSegments(span)) add(checkCommand(segment, known));
      add([slashFinding(span, known), configFinding(span, known)]);
    }
  });
  return out;
}
