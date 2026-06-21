/**
 * Memory tool schemas and handlers.
 *
 * Three tools for cross-session memory: memory_search (read-only fact lookup),
 * memory_update (write hot memory or facts), and procedure_write (write reusable procedures).
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
  MemoryUpdateAction,
  MemoryUpdateTarget,
  MemorySearchResult,
} from './types.js';

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
  // Closure captures the store reference. Handlers return raw JSON
  // content for the model; per-tool display strings for the interactive
  // tool-lane are derived by the registry in
  // `src/agent/tools/render-registry.ts` from this content.
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
      const message = err instanceof Error ? err.message : String(err);
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
          // Non-fatal overflow: saveHot kept the content and truncated the
          // tail. Tell the agent so it moves detail to the fact archive
          // rather than re-submitting an even larger blob.
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
        // Evidence gate (opt-in): a codebase fact stored without a citation is
        // not rejected — it is stored and will be recalled as [unverified].
        // Surface a warning so the agent can supply evidence next time.
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
        // Read the prior fact first so the gate can classify the *resolved*
        // category/evidence for the write-time warning. supersedeFact re-reads
        // it internally; this extra read is off the hot path (memory_update is
        // a low-frequency tool) and returns null for a missing id — in which
        // case supersedeFact throws the same "not found" error below.
        const prior = store.getFact(parsed.supersedes);
        // evidence: `undefined` carries the prior citation forward; an explicit
        // string replaces it (empty/whitespace normalizes to null = cleared).
        const freshEvidence =
          parsed.evidence === undefined ? undefined : normalizeEvidence(parsed.evidence);
        // supersedeFact accepts category?: string, which is compatible with FactCategory | undefined.
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
        // Evidence gate (opt-in): mirror the `set` warning on the supersede
        // path. supersede is the recommended way to update a fact, so an
        // uncited codebase fact must nudge here too. The warning reflects the
        // RESOLVED state after carry-forward: a fresh citation silences it; a
        // carried-forward citation warns it may be stale; no citation at all
        // warns it will be recalled as [unverified].
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
      const message = err instanceof Error ? err.message : String(err);
      return { content: `memory_update error: ${message}`, isError: true };
    }
  };

  const procedureWriteHandler: ToolHandler = async (input: unknown) => {
    try {
      const parsed = parseProcedureWriteInput(input);
      store.writeProcedure(parsed.name, parsed.content, sessionId);
      return { content: JSON.stringify({ name: parsed.name, written: true }) };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { content: `procedure_write error: ${message}`, isError: true };
    }
  };

  return new Map<string, ToolHandler>([
    ['memory_search', memorySearchHandler],
    ['memory_update', memoryUpdateHandler],
    ['procedure_write', procedureWriteHandler],
  ]);
}

// ── Input parsing ──────────────────────────────────────────────────────────

interface MemorySearchInput {
  query: string;
  category?: FactCategory;
  since?: string;
  limit?: number;
}

function parseMemorySearchInput(input: unknown): MemorySearchInput {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Input must be an object');
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj['query'] !== 'string') {
    throw new Error('query (string) is required');
  }

  const parsed: MemorySearchInput = {
    query: obj['query'],
  };

  if (obj['category'] !== undefined) {
    if (typeof obj['category'] !== 'string') {
      throw new Error('category must be a string');
    }
    const validCategories: FactCategory[] = ['preference', 'convention', 'decision', 'learning'];
    if (!validCategories.includes(obj['category'] as FactCategory)) {
      throw new Error(
        `category must be one of: ${validCategories.join(', ')}`,
      );
    }
    parsed.category = obj['category'] as FactCategory;
  }

  if (obj['since'] !== undefined) {
    if (typeof obj['since'] !== 'string') {
      throw new Error('since must be a string (ISO date)');
    }
    parsed.since = obj['since'];
  }

  if (obj['limit'] !== undefined) {
    if (typeof obj['limit'] !== 'number' || obj['limit'] <= 0) {
      throw new Error('limit must be a positive number');
    }
    parsed.limit = obj['limit'];
  }

  return parsed;
}

interface MemoryUpdateInput {
  target: MemoryUpdateTarget;
  action: MemoryUpdateAction;
  content?: string;
  category?: FactCategory;
  evidence?: string;
  supersedes?: number;
  id?: number;
}

function parseMemoryUpdateInput(input: unknown): MemoryUpdateInput {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Input must be an object');
  }
  const obj = input as Record<string, unknown>;

  const validTargets: MemoryUpdateTarget[] = ['hot', 'fact'];
  if (typeof obj['target'] !== 'string' || !validTargets.includes(obj['target'] as MemoryUpdateTarget)) {
    throw new Error(`target must be one of: ${validTargets.join(', ')}`);
  }

  const validActions: MemoryUpdateAction[] = ['set', 'supersede', 'remove'];
  if (typeof obj['action'] !== 'string' || !validActions.includes(obj['action'] as MemoryUpdateAction)) {
    throw new Error(`action must be one of: ${validActions.join(', ')}`);
  }

  const parsed: MemoryUpdateInput = {
    target: obj['target'] as MemoryUpdateTarget,
    action: obj['action'] as MemoryUpdateAction,
  };

  if (obj['content'] !== undefined) {
    if (typeof obj['content'] !== 'string') {
      throw new Error('content must be a string');
    }
    parsed.content = obj['content'];
  }

  if (obj['category'] !== undefined) {
    if (typeof obj['category'] !== 'string') {
      throw new Error('category must be a string');
    }
    const validCategories: FactCategory[] = ['preference', 'convention', 'decision', 'learning'];
    if (!validCategories.includes(obj['category'] as FactCategory)) {
      throw new Error(
        `category must be one of: ${validCategories.join(', ')}`,
      );
    }
    parsed.category = obj['category'] as FactCategory;
  }

  if (obj['evidence'] !== undefined) {
    if (typeof obj['evidence'] !== 'string') {
      throw new Error('evidence must be a string');
    }
    parsed.evidence = obj['evidence'];
  }

  if (obj['supersedes'] !== undefined) {
    if (typeof obj['supersedes'] !== 'number' || obj['supersedes'] <= 0) {
      throw new Error('supersedes must be a positive fact ID');
    }
    parsed.supersedes = obj['supersedes'];
  }

  if (obj['id'] !== undefined) {
    if (typeof obj['id'] !== 'number' || obj['id'] <= 0) {
      throw new Error('id must be a positive fact ID');
    }
    parsed.id = obj['id'];
  }

  return parsed;
}

interface ProcedureWriteInput {
  name: string;
  content: string;
}

function parseProcedureWriteInput(input: unknown): ProcedureWriteInput {
  if (typeof input !== 'object' || input === null) {
    throw new Error('Input must be an object');
  }
  const obj = input as Record<string, unknown>;

  if (typeof obj['name'] !== 'string') {
    throw new Error('name (string) is required');
  }
  if (typeof obj['content'] !== 'string') {
    throw new Error('content (string) is required');
  }

  return {
    name: obj['name'],
    content: obj['content'],
  };
}
