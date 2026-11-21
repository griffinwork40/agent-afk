/**
 * Display labels for delegation tools and child-originated approval requests
 * (profile section 6, decision D9). Pure string helpers, no policy decisions.
 *
 * @module cli/commands/acp.permission.labels
 */
import type { ChildToolOrigin } from '../../agent/tools/nesting.can-use-tool.js';
import { escapeInvisible } from './acp.tool-title.js';

const DELEGATION_TOOLS = new Set(['agent', 'skill', 'compose', 'remote_agent']);
/** In-process children are asked per tool call (D9). */
export const DELEGATION_SUFFIX = ' (each subagent tool call is asked separately)';
/** remote_agent runs elsewhere; this session's prompts do not cover it (D9). */
export const REMOTE_SUFFIX = ' (runs on another machine; its actions are NOT asked in this session)';

export function delegationSuffix(toolName: string): string {
  if (toolName === 'remote_agent') return REMOTE_SUFFIX;
  return DELEGATION_TOOLS.has(toolName) ? DELEGATION_SUFFIX : '';
}

const ROUTE_WORD: Record<string, string> = { agent: 'subagent', skill: 'skill', compose: 'compose node' };

function clean(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Control characters and brackets cannot forge a second label in the title.
  // Direction overrides and other invisible characters become visible `<U+XXXX>`
  // escapes (the write boundary's pass), so the origin reaches the child card's
  // closing text (acp.permission closeChildCard) in the same safe form.
  return escapeInvisible(value.replace(/[\u0000-\u001f\u007f[\]]/g, '').trim().slice(0, 64));
}

/**
 * Title prefix for a child-originated request, e.g. `[subagent research-agent]`,
 * `[skill user-skill-foo]`, `[compose node build depth 2]`. Never empty: a
 * missing or malformed origin still yields `[subagent]`.
 */
export function childPrefix(origin: ChildToolOrigin | undefined): string {
  const o = (typeof origin === 'object' && origin !== null ? origin : {}) as Partial<ChildToolOrigin>;
  const route = typeof o.route === 'string' && ROUTE_WORD[o.route] !== undefined ? ROUTE_WORD[o.route]! : 'subagent';
  const type = clean(o.agentType);
  const label = clean(o.label);
  const name = type !== '' && label !== '' && type !== label ? `${type} ${label}` : type || label;
  const depth = typeof o.depth === 'number' && Number.isSafeInteger(o.depth) && o.depth > 1 ? ` depth ${o.depth}` : '';
  return `[${[route, name].filter((s) => s !== '').join(' ')}${depth}]`;
}
