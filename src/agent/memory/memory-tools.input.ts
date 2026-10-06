/**
 * Input validation/parsing for the three memory tool handlers.
 *
 * Extracted from memory-tools.ts to keep that file under the 350-code-line
 * ceiling. All functions are pure (no I/O, no side effects).
 *
 * @module agent/memory/memory-tools.input
 */

import type { FactCategory, MemoryUpdateAction, MemoryUpdateTarget } from './types.js';

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
