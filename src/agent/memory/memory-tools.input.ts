/**
 * Input validation/parsing for the three memory tool handlers.
 *
 * Extracted from memory-tools.ts to keep that file under the 350-code-line
 * ceiling. All functions are pure (no I/O, no side effects).
 *
 * @module agent/memory/memory-tools.input
 */

import type { FactCategory, MemoryUpdateAction, MemoryUpdateTarget } from './types.js';

/** The allowed FactCategory values — single source of truth for this module. */
const VALID_FACT_CATEGORIES: readonly FactCategory[] = ['preference', 'convention', 'decision', 'learning'];

/**
 * Parse and validate an optional `category` field from a raw input object.
 *
 * When `obj['category']` is absent, returns `undefined` (field is optional).
 * When present but not a string, throws. When a string but not a valid
 * {@link FactCategory}, throws with the canonical error message.
 * When valid, returns the typed value.
 *
 * Shared by `parseMemorySearchInput` and `parseMemoryUpdateInput`.
 */
export function parseOptionalFactCategory(obj: Record<string, unknown>): FactCategory | undefined {
  if (obj['category'] === undefined) return undefined;
  if (typeof obj['category'] !== 'string') {
    throw new Error('category must be a string');
  }
  if (!VALID_FACT_CATEGORIES.includes(obj['category'] as FactCategory)) {
    throw new Error(`category must be one of: ${VALID_FACT_CATEGORIES.join(', ')}`);
  }
  return obj['category'] as FactCategory;
}

export interface MemorySearchInput {
  query: string;
  category?: FactCategory;
  since?: string;
  limit?: number;
}

export function parseMemorySearchInput(input: unknown): MemorySearchInput {
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

  const category = parseOptionalFactCategory(obj);
  if (category !== undefined) parsed.category = category;

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

export interface MemoryUpdateInput {
  target: MemoryUpdateTarget;
  action: MemoryUpdateAction;
  content?: string;
  category?: FactCategory;
  evidence?: string;
  supersedes?: number;
  id?: number;
}

export function parseMemoryUpdateInput(input: unknown): MemoryUpdateInput {
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

  const category = parseOptionalFactCategory(obj);
  if (category !== undefined) parsed.category = category;

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

export interface ProcedureWriteInput {
  name: string;
  content: string;
}

export function parseProcedureWriteInput(input: unknown): ProcedureWriteInput {
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
