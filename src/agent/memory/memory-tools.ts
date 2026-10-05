/**
 * Memory tool schemas and handlers.
 *
 * Three tools for cross-session memory: memory_search (read-only fact lookup),
 * memory_update (write hot memory or facts), and procedure_write (write reusable procedures).
 *
 * Input validation/parsing: memory-tools.input.ts
 *
 * @module agent/memory/memory-tools
 */

import type { AnthropicToolDef, ToolHandler } from '../tools/types.js';
import { MemoryStore, HOT_SOFT_WARN_RATIO } from './memory-store.js';
import {
  evidenceGateEnabled,
  requiresEvidence,
  verificationStatus,
  applyUnverifiedTag,
  normalizeEvidence,
} from './memory-evidence.js';
import type {
  FactCategory,
  MemorySearchResult,
} from './types.js';
import { errorMessage } from '../../utils/errors.js';
import {
  parseMemorySearchInput,
  parseMemoryUpdateInput,
  parseProcedureWriteInput,
} from './memory-tools.input.js';

/**
 * memory_search: Query the cross-session fact archive. Returns facts + procedures
 * ranked by relevance. Use FTS5 syntax for advanced queries.
 */
export const memorySearchTool: AnthropicToolDef = {
  name: 'memory_search',
  category: 'read',
  concurrencySafe: true,
  description:
    'Search cross-session memory for facts and procedures. Returns results ranked by relevance. ' +
    'Use this to recall information from prior sessions. Supports FTS5 match syntax: AND, OR, NOT, "exact phrase", prefix*',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search query (supports FTS5 match syntax: AND, OR, NOT, "exact phrase", prefix*)',
      },
      category: {
        type: 'string',
        enum: ['preference', 'convention', 'decision', 'learning'],
        description: 'Optional: filter by fact category',
      },
      since: {
        type: 'string',
        description: 'Optional: ISO date — only return facts created after this date',
      },
      limit: {
        type: 'number',
        description: 'Max results (default 10)',
      },
    },
    required: ['query'],
  },
};

/**
 * memory_update: Store or update facts in hot memory or the fact archive.
 * Hot memory (target: "hot") is injected into the system prompt for all future sessions.
 * Facts (target: "fact") are stored in the searchable SQLite archive.
 */
export const memoryUpdateTool: AnthropicToolDef = {
  name: 'memory_update',
  category: 'write',
  concurrencySafe: false,
  description:
    'Store a fact in cross-session memory or update hot memory. ' +
    'Hot memory (target: "hot") persists in the system prompt across all future sessions. ' +
    'Facts (target: "fact") are stored in the searchable archive.',
  input_schema: {
    type: 'object',
    properties: {
      target: {
        type: 'string',
        enum: ['hot', 'fact'],
        description: '"hot" writes to HOT.md (system prompt), "fact" writes to the searchable archive',
      },
      action: {
        type: 'string',
        enum: ['set', 'supersede', 'remove'],
        description: 'Operation: set (create/overwrite), supersede (replace while keeping history), remove (delete)',
      },
      content: {
        type: 'string',
        description: 'The content to store (for set/supersede)',
      },
      category: {
        type: 'string',
        enum: ['preference', 'convention', 'decision', 'learning'],
        description: 'Required for fact target',
      },
      evidence: {
        type: 'string',
        description:
          'Optional provenance citation backing a codebase fact — a file:line, commit SHA, ' +
          'or trace-event id. When the evidence gate is enabled, a "convention" fact stored ' +
          'without it is recalled as [unverified]; preferences and reflections never need it.',
      },
      supersedes: {
        type: 'number',
        description: 'Fact ID being superseded (for supersede action)',
      },
      id: {
        type: 'number',
        description: 'Fact ID to remove (for remove action)',
      },
    },
    required: ['target', 'action'],
  },
};

/**
 * procedure_write: Store a reusable procedure (markdown file).
 * Procedures persist across sessions and are searchable via memory_search.
 */
export const procedureWriteTool: AnthropicToolDef = {
  name: 'procedure_write',
  category: 'write',
  concurrencySafe: false,
  description:
    'Write a reusable procedure to memory. Procedures are markdown files describing ' +
    'how to perform recurring tasks. They persist across sessions and are searchable via memory_search.',
  input_schema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Procedure name (kebab-case, becomes the filename)',
      },
      content: {
        type: 'string',
        description: 'Procedure content (markdown)',
      },
    },
    required: ['name', 'content'],
  },
};

/** All three memory tool schemas. */
export const memoryToolSchemas: readonly AnthropicToolDef[] = [
  memorySearchTool,
  memoryUpdateTool,
  procedureWriteTool,
];

export const MEMORY_TOOL_NAMES = memoryToolSchemas.map((t) => t.name);

// ── Evidence-gate policy (opt-in: AFK_MEMORY_EVIDENCE_GATE=1) ─────────────────

/** Returned on a `set`/`supersede` of an uncited codebase fact under the gate. */
const UNCITED_CODEBASE_FACT_WARNING =
  'Stored without evidence — this codebase fact (category "convention") will be recalled as ' +
  '[unverified]. Supply `evidence` (a file:line, commit SHA, or trace-event id) so future ' +
  'sessions can trust it as ground truth rather than an unverified agent claim.';

/**
 * Returned on a `supersede` of a codebase fact that carries a prior citation
 * forward unchanged (no fresh evidence supplied this call). The recall verdict
 * stays 'verified' against the OLD evidence, which may no longer back the
 * changed content — so the warning nudges the agent to re-cite.
 */
const INHERITED_CITATION_SUPERSEDE_WARNING =
  'Superseded without fresh evidence — the prior citation is carried forward and this ' +
  'codebase fact (category "convention") is still recalled as verified against the OLD ' +
  'evidence, which may not back the changed content. Re-supply `evidence` if the claim ' +
  'changed (or pass an empty string to clear it and recall as [unverified]).';

/**
 * Project raw search results onto the wire shape returned to the agent.
 *
 *   - gate OFF → provenance fields (`evidence`, `verification`) are dropped, so
 *     the JSON is byte-identical to pre-gate behavior (a true no-op).
 *   - gate ON  → each codebase fact gains a `verification` verdict and any
 *     uncited one has its `content` prefixed with `[unverified]`. Preferences,
 *     reflections, and procedures are passed through verdict 'not-applicable'
 *     (no tag) so a reflection is never lent false factual authority.
 *
 * Pure: no I/O, no env read (the gate flag is resolved by the caller).
 */
function projectSearchResults(
  results: MemorySearchResult[],
  gateOn: boolean,
): MemorySearchResult[] {
  if (!gateOn) {
    return results.map((r) => {
      const legacy = { ...r };
      delete legacy.evidence;
      delete legacy.verification;
      return legacy;
    });
  }
  return results.map((r) => {
    if (r.type !== 'fact' || !r.category) {
      return { ...r, verification: 'not-applicable' as const };
    }
    const verification = verificationStatus(r.category, r.evidence);
    return { ...r, verification, content: applyUnverifiedTag(r.content, verification) };
  });
}

// ── Handler implementations ─────────────────────────────────────────────────

/**
 * Create a set of memory tool handlers bound to a MemoryStore instance.
 * Handlers are returned as a Map for easy wiring into SessionToolDispatcher.
 *
 * The optional `sessionId` and `surface` parameters are used for fact metadata
 * and procedure origin tracking.
 */
export function createMemoryHandlers(
  store: MemoryStore,
  sessionId?: string,
  surface?: string,
): Map<string, ToolHandler> {
  const memorySearchHandler: ToolHandler = async (input: unknown) => {
    try {
      const parsed = parseMemorySearchInput(input);
      const results = store.search(parsed.query, {
        category: parsed.category,
        since: parsed.since,
        limit: parsed.limit ?? 10,
      });
      return { content: JSON.stringify(projectSearchResults(results, evidenceGateEnabled())) };
    } catch (err) {
      const message = errorMessage(err);
      return { content: `memory_search error: ${message}`, isError: true };
    }
  };

  const memoryUpdateHandler: ToolHandler = async (input: unknown) => {
    try {
      const parsed = parseMemoryUpdateInput(input);

      if (parsed.target === 'hot') {
        // Hot memory only supports 'set' action
        if (parsed.action !== 'set') {
          return {
            content: 'Hot memory only supports action: "set". Use supersede/remove only for facts.',
            isError: true,
          };
        }
        if (!parsed.content) {
          return {
            content: 'content is required for action: "set"',
            isError: true,
          };
        }
        const usage = store.saveHot(parsed.content);
        const result: Record<string, unknown> = {
          saved: true,
          target: 'hot',
          usage: { tokens: usage.tokens, maxTokens: usage.maxTokens, pct: usage.pct },
        };
        if (usage.truncated) {
          result['truncated'] = true;
          result['note'] =
            'Hot memory exceeded the ~1,500-token cap and was truncated from the end ' +
            '(lowest-priority lines dropped; a sentinel marks the cut). Keep hot memory to a ' +
            'few durable essentials — move detail to the fact archive with target:"fact".';
        } else if (usage.pct >= HOT_SOFT_WARN_RATIO * 100) {
          result['warning'] =
            `Hot memory is at ${usage.pct}% of the ~1,500-token cap. ` +
            'Move non-essential lines to the fact archive (target:"fact") before it truncates.';
        }
        return { content: JSON.stringify(result) };
      }

      // target === 'fact'
      if (parsed.action === 'set') {
        if (!parsed.category) {
          return {
            content: 'category is required for fact storage',
            isError: true,
          };
        }
        if (!parsed.content) {
          return {
            content: 'content is required for action: "set"',
            isError: true,
          };
        }
        const category = parsed.category as FactCategory;
        const evidence = normalizeEvidence(parsed.evidence);
        const id = store.storeFact({
          session_id: sessionId,
          category,
          content: parsed.content,
          source_surface: surface ?? 'cli',
          evidence,
        });
        const result: Record<string, unknown> = { id, action: 'set', target: 'fact' };
        if (evidenceGateEnabled() && requiresEvidence(category) && !evidence) {
          result['warning'] = UNCITED_CODEBASE_FACT_WARNING;
        }
        return { content: JSON.stringify(result) };
      }

      if (parsed.action === 'supersede') {
        if (!parsed.supersedes) {
          return {
            content: 'supersedes (fact ID) is required for action: "supersede"',
            isError: true,
          };
        }
        if (!parsed.content) {
          return {
            content: 'content is required for action: "supersede"',
            isError: true,
          };
        }
        const prior = store.getFact(parsed.supersedes);
        const freshEvidence =
          parsed.evidence === undefined ? undefined : normalizeEvidence(parsed.evidence);
        const newId = store.supersedeFact(
          parsed.supersedes,
          parsed.content,
          parsed.category ?? undefined,
          freshEvidence,
        );
        const result: Record<string, unknown> = {
          id: newId,
          action: 'supersede',
          target: 'fact',
          supersedes: parsed.supersedes,
        };
        if (evidenceGateEnabled()) {
          const resolvedCategory: FactCategory | undefined = parsed.category ?? prior?.category;
          if (resolvedCategory && requiresEvidence(resolvedCategory)) {
            const resolvedEvidence = freshEvidence === undefined ? (prior?.evidence ?? null) : freshEvidence;
            if (!resolvedEvidence) {
              result['warning'] = UNCITED_CODEBASE_FACT_WARNING;
            } else if (freshEvidence === undefined) {
              result['warning'] = INHERITED_CITATION_SUPERSEDE_WARNING;
            }
          }
        }
        return { content: JSON.stringify(result) };
      }

      if (parsed.action === 'remove') {
        if (!parsed.id) {
          return {
            content: 'id (fact ID) is required for action: "remove"',
            isError: true,
          };
        }
        const removed = store.removeFact(parsed.id);
        return { content: JSON.stringify({ removed, action: 'remove', target: 'fact' }) };
      }

      return {
        content: `Unknown action: ${parsed.action}`,
        isError: true,
      };
    } catch (err) {
      const message = errorMessage(err);
      return { content: `memory_update error: ${message}`, isError: true };
    }
  };

  const procedureWriteHandler: ToolHandler = async (input: unknown) => {
    try {
      const parsed = parseProcedureWriteInput(input);
      store.writeProcedure(parsed.name, parsed.content, sessionId);
      return { content: JSON.stringify({ name: parsed.name, written: true }) };
    } catch (err) {
      const message = errorMessage(err);
      return { content: `procedure_write error: ${message}`, isError: true };
    }
  };

  return new Map<string, ToolHandler>([
    ['memory_search', memorySearchHandler],
    ['memory_update', memoryUpdateHandler],
    ['procedure_write', procedureWriteHandler],
  ]);
}
