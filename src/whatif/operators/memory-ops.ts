/**
 * Memory operators: memory-add and memory-remove.
 *
 * Uses MemoryStore (better-sqlite3 backed) at the sandbox state/memory dir.
 *
 * @module whatif/operators/memory-ops
 */

import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { ChangeOperator, OperatorContext } from '../types.js';
import { MemoryStore } from '../../agent/memory/memory-store.js';

// ---------------------------------------------------------------------------
// memory-add
// ---------------------------------------------------------------------------

export const memoryAddOperator: ChangeOperator<'memory-add'> = {
  kind: 'memory-add',

  touchesProject(_change) {
    return false;
  },

  homePathsToCopy(_change) {
    // state/memory is a real directory created by the sandbox materializer;
    // no symlink to break through.
    return [];
  },

  async apply(change, env, _ctx) {
    const memDir = join(env.home, 'state', 'memory');
    mkdirSync(memDir, { recursive: true });
    const store = new MemoryStore(memDir);
    try {
      store.storeFact({
        session_id: 'whatif',
        category: change.category,
        content: change.content,
        source_surface: 'whatif',
      });
    } finally {
      store.close();
    }
  },

  describe(change) {
    const preview =
      change.content.length > 60
        ? change.content.slice(0, 57) + '...'
        : change.content;
    return `Remember a new fact: "${preview}"`;
  },
};

// ---------------------------------------------------------------------------
// memory-remove
// ---------------------------------------------------------------------------

export const memoryRemoveOperator: ChangeOperator<'memory-remove'> = {
  kind: 'memory-remove',

  touchesProject(_change) {
    return false;
  },

  homePathsToCopy(_change) {
    return [];
  },

  async apply(change, env, _ctx: OperatorContext) {
    const memDir = join(env.home, 'state', 'memory');
    mkdirSync(memDir, { recursive: true });
    const store = new MemoryStore(memDir);
    try {
      const removed = store.removeFact(change.id);
      if (!removed) {
        throw new Error(
          `[whatif] memory-remove: fact id ${change.id} not found in sandbox memory store`,
        );
      }
    } finally {
      store.close();
    }
  },

  describe(change) {
    return `Remove memory fact #${change.id}`;
  },
};
