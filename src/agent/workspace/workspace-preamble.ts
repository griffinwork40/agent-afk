/**
 * Workspace context preamble — formats shared workspace entries for injection
 * into a forked child's system prompt.
 *
 * Renderer and injector for workspace entries. The injector delegates the
 * system-prompt union handling to `appendSystemPromptBlock`.
 *
 * @module agent/workspace/workspace-preamble
 */

import type { AgentConfig } from '../types/config-types.js';
import type { WorkspaceEntry } from './workspace-store.js';
import { appendSystemPromptBlock } from '../subagent/append-system-prompt-block.js';

/**
 * Which workspace tools the receiving child can actually call.
 *
 * Contract: `undefined` (at every call site that takes it) means "unknown",
 * and the preamble keeps its legacy hedged wording byte-for-byte. A defined
 * value is authoritative: a tool marked `false` is never named in the
 * preamble, so a child whose allowlist excludes it is never told to call it
 * (#4060 — small models act on hedged "if available, call it" text).
 */
export interface WorkspaceToolAccess {
  publish: boolean;
  query: boolean;
}

/** Tool-usage lines under the populated-preamble header. */
function populatedUsageLines(access: WorkspaceToolAccess | undefined): string[] {
  if (access === undefined) {
    return [
      'Use them to avoid re-discovering known facts. If your tool allowlist includes',
      '`workspace_query`, poll for newer entries mid-run; publish new discoveries',
      'with `workspace_publish` only if it is available to you.',
    ];
  }
  return [
    'Use them to avoid re-discovering known facts.',
    ...(access.query ? ['Call `workspace_query` to poll for newer entries mid-run.'] : []),
    ...(access.publish ? ['Publish new discoveries with `workspace_publish`.'] : []),
  ];
}

/**
 * Render workspace entries as a readable context block.
 *
 * Each entry appears between `---` dividers with its id, type, confidence,
 * agent, subject, content, and evidence (when present). The findings are
 * always rendered (reading them needs no tool); only the tool-usage lines
 * depend on `access` (see {@link WorkspaceToolAccess}).
 */
export function renderWorkspacePreamble(
  entries: WorkspaceEntry[],
  access?: WorkspaceToolAccess,
): string {
  const lines: string[] = [
    WORKSPACE_CONTEXT_HEADER,
    '',
    'The following findings were published by other agents working on this task.',
    ...populatedUsageLines(access),
  ];

  for (const entry of entries) {
    lines.push('');
    lines.push('---');

    // Header line: #id Type (confidence: X, agent: Y)
    const meta: string[] = [];
    meta.push(`confidence: ${entry.confidence.toFixed(2)}`);
    if (entry.agent_id) meta.push(`agent: ${entry.agent_id}`);
    const metaStr = meta.length > 0 ? ` (${meta.join(', ')})` : '';
    const label = capitalise(entry.type);
    lines.push(`#${entry.id} ${label}${metaStr}`);

    if (entry.subject) {
      lines.push(`Subject: ${entry.subject}`);
    }

    lines.push(entry.content);

    if (entry.evidence) {
      try {
        const refs = JSON.parse(entry.evidence) as unknown;
        if (Array.isArray(refs) && refs.length > 0) {
          lines.push(`Evidence: ${(refs as string[]).join(', ')}`);
        }
      } catch {
        // Malformed JSON — omit silently
      }
    }

    if (entry.relates_to && entry.relation_type) {
      try {
        const ids = JSON.parse(entry.relates_to) as unknown;
        if (Array.isArray(ids) && ids.length > 0) {
          lines.push(`Relation: ${entry.relation_type} → #${(ids as number[]).join(', #')}`);
        }
      } catch {
        // Malformed JSON — omit silently
      }
    }
  }

  lines.push('---');
  const full = lines.join('\n');

  // Cap total preamble at 32 KiB to prevent sibling system-prompt bloat.
  // Trim from the start (oldest entries) so the most-recent findings survive.
  const MAX_BYTES = 32 * 1024;
  if (full.length <= MAX_BYTES) return full;
  const notice = `\n---\n${WORKSPACE_TRUNCATED_NOTICE}\n`;
  const tail = full.slice(full.length - MAX_BYTES + notice.length);
  const dividerIdx = tail.indexOf('\n---\n');
  const aligned = dividerIdx >= 0 ? tail.slice(dividerIdx) : tail;
  return notice + aligned;
}

/**
 * Append the workspace context preamble to a forked child's system prompt.
 *
 * Injects a cold-start hint when entries is empty, otherwise the rendered
 * preamble. System-prompt union handling delegated to
 * `appendSystemPromptBlock`. Does not mutate the input.
 *
 * Contract: returns the input config UNCHANGED (same reference) when there is
 * nothing to inject, i.e. the workspace is empty and `access` says the child
 * cannot publish. A cold-start hint only exists to invite the first publish,
 * so a child that cannot publish gets no block at all. Callers detect "no
 * preamble" by reference equality. Otherwise returns a new config.
 */
export function injectWorkspacePreamble(
  config: AgentConfig,
  entries: WorkspaceEntry[],
  access?: WorkspaceToolAccess,
): AgentConfig {
  // Cold-start hint: even with zero entries, tell the child about workspace_publish
  // so the first agent to discover something can seed the workspace for siblings.
  if (entries.length === 0) {
    if (access === undefined) return appendSystemPromptBlock(config, COLD_START_HINT);
    if (!access.publish) return config;
    return appendSystemPromptBlock(config, grantedColdStartHint(access.query));
  }
  return appendSystemPromptBlock(config, renderWorkspacePreamble(entries, access));
}

// ── Constants ────────────────────────────────────────────────────────────────

/** First line of a populated workspace preamble. */
export const WORKSPACE_CONTEXT_HEADER = '# Workspace context (shared findings from sibling agents)';
/** First line of the cold-start (empty workspace) preamble. */
export const WORKSPACE_COLD_START_HEADER = '# Workspace (shared agent scratchpad)';
/** Leading line of a preamble that hit the 32 KiB cap (its header was trimmed). */
export const WORKSPACE_TRUNCATED_NOTICE = '[Workspace preamble truncated: too many entries. Earlier entries omitted.]';

/**
 * Contract: every rendered workspace preamble contains one of these strings
 * on its first non-blank line. The anthropic-direct provider splits the
 * system prompt there (`query-system.ts`, #3878) so the per-fork,
 * time-varying workspace preamble never sits inside the sibling-shared cached
 * prefix. Changing a header without updating this list silently re-merges the
 * preamble into the cached block; `sibling-cache-prefix.test.ts` pins it.
 */
export const WORKSPACE_PREAMBLE_MARKERS: readonly string[] = [
  WORKSPACE_CONTEXT_HEADER,
  WORKSPACE_COLD_START_HEADER,
  WORKSPACE_TRUNCATED_NOTICE,
];

/**
 * Injected when the workspace is empty so the first agent knows the tool exists.
 * Breaks the chicken-and-egg: agents can't discover workspace_publish from an
 * empty preamble, so nobody ever publishes, so the preamble stays empty.
 * See also WORKSPACE_SYSTEM_PROMPT in tools/system-prompt.ts.
 */
const COLD_START_HINT = [
  WORKSPACE_COLD_START_HEADER,
  '',
  'No entries published yet — you may be the first. If `workspace_publish` is available, call it when you:',
  '- confirm an architectural invariant or key export surface of a module,',
  '- rule out a hypothesis (so siblings skip the same dead end),',
  '- read a file another sibling will likely need (publish the insight, not the raw content).',
  '',
  'If `workspace_query` is available, call it before reading a file or grepping a module —',
  'a sibling may have analyzed it. Otherwise use your available read tools directly.',
].join('\n');

/**
 * Cold-start hint for a child KNOWN to hold `workspace_publish`. Unlike
 * {@link COLD_START_HINT} it states the call plainly, and names
 * `workspace_query` only when that tool is granted too.
 */
function grantedColdStartHint(canQuery: boolean): string {
  return [
    WORKSPACE_COLD_START_HEADER,
    '',
    'No entries published yet; you may be the first. Call `workspace_publish` when you:',
    '- confirm an architectural invariant or key export surface of a module,',
    '- rule out a hypothesis (so siblings skip the same dead end),',
    '- read a file another sibling will likely need (publish the insight, not the raw content).',
    ...(canQuery
      ? ['', 'Call `workspace_query` before reading a file or grepping a module; a sibling may have analyzed it.']
      : []),
  ].join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function capitalise(s: string): string {
  return s.length === 0 ? s : (s[0]?.toUpperCase() ?? '') + s.slice(1);
}
