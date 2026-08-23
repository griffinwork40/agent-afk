/**
 * Workspace context preamble — formats shared workspace entries for injection
 * into a forked child's system prompt.
 *
 * Pattern mirrors `src/agent/subagent/budget-preamble.ts`: a pure renderer
 * and a config-mutating injector that handles the string / preset-object /
 * undefined system-prompt union.
 *
 * @module agent/workspace/workspace-preamble
 */

import type { AgentConfig } from '../types/config-types.js';
import type { WorkspaceEntry } from './workspace-store.js';

/**
 * Render workspace entries as a readable context block.
 *
 * Each entry appears between `---` dividers with its id, type, confidence,
 * agent, subject, content, and evidence (when present).
 */
export function renderWorkspacePreamble(entries: WorkspaceEntry[]): string {
  const lines: string[] = [
    '# Workspace context (shared findings from sibling agents)',
    '',
    'The following findings were published by other agents working on this task.',
    'Use them to avoid re-discovering known facts. Call `workspace_query` to poll',
    'for newer entries mid-run. Publish new discoveries with `workspace_publish`.',
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
  const notice = '\n---\n[Workspace preamble truncated: too many entries. Earlier entries omitted.]\n';
  const tail = full.slice(full.length - MAX_BYTES + notice.length);
  const dividerIdx = tail.indexOf('\n---\n');
  const aligned = dividerIdx >= 0 ? tail.slice(dividerIdx) : tail;
  return notice + aligned;
}

/**
 * Append the workspace context preamble to a forked child's system prompt.
 *
 * Always returns a new config — injects a cold-start hint when entries is empty, otherwise the rendered preamble.
 * Handles the same system-prompt union as `injectToolBudgetPreamble`:
 *   - string → append with `\n\n`
 *   - preset object → append to `sp.append`
 *   - undefined → preamble becomes the system prompt
 *
 * Does not mutate the input — returns a shallow copy.
 */
export function injectWorkspacePreamble(
  config: AgentConfig,
  entries: WorkspaceEntry[],
): AgentConfig {
  // Cold-start hint: even with zero entries, tell the child about workspace_publish
  // so the first agent to discover something can seed the workspace for siblings.
  const block =
    entries.length === 0
      ? COLD_START_HINT
      : renderWorkspacePreamble(entries);
  const sp = config.systemPrompt;

  if (typeof sp === 'string') {
    return sp.length > 0
      ? { ...config, systemPrompt: `${sp}\n\n${block}` }
      : { ...config, systemPrompt: block };
  }

  if (sp && typeof sp === 'object' && 'type' in sp && sp.type === 'preset') {
    const existingAppend = sp.append ?? '';
    return {
      ...config,
      systemPrompt: {
        ...sp,
        append: existingAppend.length > 0 ? `${existingAppend}\n\n${block}` : block,
      },
    };
  }

  // No system prompt set — preamble becomes the system prompt.
  return { ...config, systemPrompt: block };
}

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Injected when the workspace is empty so the first agent knows the tool exists.
 * Breaks the chicken-and-egg: agents can't discover workspace_publish from an
 * empty preamble, so nobody ever publishes, so the preamble stays empty.
 * See also WORKSPACE_SYSTEM_PROMPT in tools/system-prompt.ts.
 */
const COLD_START_HINT = [
  '# Workspace (shared agent scratchpad)',
  '',
  'No entries published yet — you may be the first. Call `workspace_publish` when you:',
  '- confirm an architectural invariant or key export surface of a module,',
  '- rule out a hypothesis (so siblings skip the same dead end),',
  '- read a file another sibling will likely need (publish the insight, not the raw content).',
  '',
  'Call `workspace_query` before reading a file or grepping a module — a sibling may have',
  'already analyzed it. Publishing is free to batch alongside other tools in the same reply.',
].join('\n');

// ── Helpers ───────────────────────────────────────────────────────────────────

function capitalise(s: string): string {
  return s.length === 0 ? s : (s[0]?.toUpperCase() ?? '') + s.slice(1);
}
