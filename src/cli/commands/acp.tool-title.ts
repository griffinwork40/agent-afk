/**
 * What a tool call does, as one bounded line for its card title (profile
 * section 5). Display only: never a permission input. Shared by live
 * `tool_call` frames, permission requests and history replay.
 *
 * @module cli/commands/acp.tool-title
 */
import { inputRecord, resolveDisplayPath, validPath } from './acp.translate.paths.js';

/** Bound on the descriptive part, so an outside path appended after it always survives. */
export const DETAIL_CHARS = 160;
const TASK_WORDS = 12;
const TASK_CHARS = 80;
export const ELLIPSIS = '…';

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v : undefined);

/**
 * One line of at most `max` characters: control characters become spaces, a
 * multi-line value keeps its first non-empty line, and any cut is marked `…`.
 */
export function oneLine(text: string, max = DETAIL_CHARS): string {
  const lines = text.split(/\r\n|\r|\n/);
  const first = lines.find((l) => l.trim().length > 0) ?? '';
  const flat = first.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  const cut = [...flat].length > max || lines.filter((l) => l.trim().length > 0).length > 1;
  const chars = [...flat];
  return cut ? `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}${ELLIPSIS}` : flat;
}

/** The first words of a task, quoted so the human can see where it ends. */
function task(v: unknown): string | undefined {
  const s = str(v);
  if (s === undefined) return undefined;
  const words = s.trim().split(/\s+/);
  const head = words.slice(0, TASK_WORDS).join(' ');
  const shown = oneLine(words.length > TASK_WORDS ? `${head}\n…` : head, TASK_CHARS);
  return `"${shown}"`;
}

function join(...parts: (string | undefined)[]): string {
  return parts.filter((p): p is string => p !== undefined && p.length > 0).join(' ');
}

function where(v: unknown, cwd: string | undefined): string | undefined {
  if (validPath(v)) return cwd !== undefined ? resolveDisplayPath(v, cwd) ?? v : v;
  return cwd;
}

function gitDetail(r: Record<string, unknown>): string {
  const args = Array.isArray(r['args']) ? r['args'].map(String) : [];
  const paths = Array.isArray(r['paths']) ? r['paths'].map(String) : [];
  const pattern = str(r['pattern']);
  return join(str(r['subcommand']), pattern !== undefined ? `-e "${pattern}"` : undefined, ...args, paths.length > 0 ? `-- ${paths.join(' ')}` : undefined);
}

function patchDetail(r: Record<string, unknown>, cwd: string | undefined): string {
  const changes = Array.isArray(r['changes']) ? r['changes'] : [];
  const first = changes.length > 0 ? where(inputRecord(changes[0])['path'], cwd) : undefined;
  if (first === undefined || !validPath(inputRecord(changes[0])['path'])) return '';
  return changes.length > 1 ? `${first} (+${changes.length - 1} more)` : first;
}

function mcpDetail(name: string): string {
  const rest = name.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  return sep <= 0 ? `MCP ${rest}` : `MCP server ${rest.slice(0, sep)}: ${rest.slice(sep + 2)}`;
}

type Describe = (r: Record<string, unknown>, cwd: string | undefined) => string | undefined;

const DETAIL: Record<string, Describe> = {
  bash: (r) => str(r['command']),
  test_run: (r) => join(str(r['file']), str(r['name'])),
  web_scrape: (r) => (r['mode'] === 'search' ? join('search', task(r['query'])) : join('GET', str(r['url']))),
  web_request: (r) => join(str(r['method'])?.toUpperCase() ?? 'GET', str(r['url'])),
  browser_open: (r) => str(r['url']),
  grep: (r, cwd) => join(str(r['pattern']) !== undefined ? `"${String(r['pattern'])}"` : undefined, where(r['path'], cwd) !== undefined ? `in ${where(r['path'], cwd)}` : undefined),
  glob: (r, cwd) => join(str(r['pattern']) !== undefined ? `"${String(r['pattern'])}"` : undefined, where(r['path'], cwd) !== undefined ? `in ${where(r['path'], cwd)}` : undefined),
  git_read: (r) => gitDetail(r),
  patch_apply: (r, cwd) => patchDetail(r, cwd),
  agent: (r) => join(str(r['agent_type']) ?? str(r['subagent_type']), task(r['prompt'])),
  skill: (r) => join(str(r['name']), task(r['arguments'])),
  compose: (r) => {
    const nodes = Array.isArray(r['nodes']) ? r['nodes'].map(inputRecord) : [];
    return nodes.length === 0 ? undefined
      : join(`${nodes.length} node${nodes.length === 1 ? '' : 's'}:`, str(nodes[0]?.['agent_type']), task(nodes[0]?.['prompt']));
  },
  remote_agent: (r) => join(str(r['host']) !== undefined ? `on ${String(r['host'])}:` : undefined, task(r['prompt'])),
  model_complete: (r) => join(str(r['model']), task(r['prompt'])),
  worktree: (r) => join(str(r['action']), str(r['name']) ?? str(r['path'])),
  image_generate: (r) => task(r['prompt']),
  image_edit: (r) => task(r['prompt']),
  send_telegram: (r) => task(r['message']),
  config_set: (r) => join(str(r['action']), str(r['key'])),
  create_schedule: (r) => join(str(r['name']), task(r['command'])),
};

/** The bounded, single-line description of what this call does, or '' when nothing is known. */
export function toolDetail(toolName: string, input: unknown, cwd: string | undefined): string {
  const r = inputRecord(input);
  const raw = toolName.startsWith('mcp__') ? mcpDetail(toolName) : DETAIL[toolName]?.(r, cwd);
  return raw === undefined || raw.length === 0 ? '' : oneLine(raw);
}
