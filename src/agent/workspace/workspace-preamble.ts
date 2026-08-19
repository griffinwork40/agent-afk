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
    'Use them to avoid re-discovering known facts. If you discover something new',
    'or contradictory, publish it with the workspace_publish tool.',
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
  return lines.join('\n');
}

/**
 * Append the workspace context preamble to a forked child's system prompt.
 *
 * No-op (returns config unchanged) when `entries` is empty.
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
  if (entries.length === 0) return config;

  const block = renderWorkspacePreamble(entries);
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function capitalise(s: string): string {
  return s.length === 0 ? s : (s[0]?.toUpperCase() ?? '') + s.slice(1);
}
