/**
 * Memory tool schemas and handlers.
 *
 * Three tools for cross-session memory: memory_search (read-only fact lookup),
 * memory_update (write hot memory or facts), and procedure_write (write reusable procedures).
 *
 * @module agent/memory/memory-tools
 */

import type { AnthropicToolDef, ToolHandler } from '../tools/types.js';
import { MemoryStore } from './memory-store.js';
import type {
  FactCategory,
  MemoryUpdateAction,
  MemoryUpdateTarget,
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
      return { content: JSON.stringify(results) };
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
        store.saveHot(parsed.content);
        return { content: JSON.stringify({ saved: true, target: 'hot' }) };
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
        const id = store.storeFact({
          session_id: sessionId,
          category: parsed.category as FactCategory,
          content: parsed.content,
          source_surface: surface ?? 'cli',
        });
        return { content: JSON.stringify({ id, action: 'set', target: 'fact' }) };
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
        // supersedeFact accepts category?: string, which is compatible with FactCategory | undefined
        const newId = store.supersedeFact(
          parsed.supersedes,
          parsed.content,
          parsed.category ?? undefined,
        );
        return {
          content: JSON.stringify({
            id: newId,
            action: 'supersede',
            target: 'fact',
            supersedes: parsed.supersedes,
          }),
        };
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
