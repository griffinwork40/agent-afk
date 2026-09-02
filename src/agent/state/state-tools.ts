/**
 * Tool handlers for the durable cross-session state store.
 *
 * Factory function that produces a Map of tool handlers for the five state
 * tools (state_get, state_put, state_cas, state_delete, state_query).
 * Each handler validates its input with Zod and delegates to StateStore.
 *
 * @module agent/state/state-tools
 */

import { z } from 'zod';
import type { ToolHandler } from '../tools/types.js';
import { StateStore } from './state-store.js';

/** Zod schema for a valid namespace or key string. */
const namespaceKey = z
  .string()
  .min(1, 'namespace/key must be non-empty')
  .max(128, 'namespace/key must not exceed 128 characters')
  .regex(/^[A-Za-z0-9_.-]+$/, 'namespace/key may only contain [A-Za-z0-9_.-]');

const GetInput = z.object({
  namespace: namespaceKey,
  key: namespaceKey,
});

const PutInput = z.object({
  namespace: namespaceKey,
  key: namespaceKey,
  value: z.unknown(),
  ttl_ms: z.number().optional(),
  metadata: z.unknown().optional(),
});

const CasInput = z.object({
  namespace: namespaceKey,
  key: namespaceKey,
  expected_version: z.number(),
  value: z.unknown(),
  ttl_ms: z.number().optional(),
  metadata: z.unknown().optional(),
});

const DeleteInput = z.object({
  namespace: namespaceKey,
  key: namespaceKey,
});

const QueryInput = z.object({
  namespace: namespaceKey,
  key_prefix: z.string().optional(),
  limit: z.number().max(100).optional(),
});

/**
 * Create tool handlers for the five state store tools.
 *
 * @param store - The StateStore instance to delegate to.
 * @param sessionId - Optional session ID recorded as the `producer` on writes.
 * @returns A Map of tool name → handler.
 */
export function createStateHandlers(
  store: StateStore,
  sessionId?: string,
): Map<string, ToolHandler> {
  const handlers = new Map<string, ToolHandler>();

  // ── state_get ────────────────────────────────────────────────────────────

  handlers.set('state_get', async (input) => {
    try {
      const { namespace, key } = GetInput.parse(input);
      const result = store.get(namespace, key);
      return { content: JSON.stringify(result) };
    } catch (err) {
      return { content: String(err), isError: true };
    }
  });

  // ── state_put ────────────────────────────────────────────────────────────

  handlers.set('state_put', async (input) => {
    try {
      const { namespace, key, value, ttl_ms, metadata } = PutInput.parse(input);
      const result = store.put(namespace, key, value, { ttl_ms, metadata }, sessionId);
      return { content: JSON.stringify(result) };
    } catch (err) {
      return { content: String(err), isError: true };
    }
  });

  // ── state_cas ────────────────────────────────────────────────────────────

  handlers.set('state_cas', async (input) => {
    try {
      const { namespace, key, expected_version, value, ttl_ms, metadata } =
        CasInput.parse(input);
      const result = store.cas(
        namespace,
        key,
        expected_version,
        value,
        { ttl_ms, metadata },
        sessionId,
      );
      return { content: JSON.stringify(result) };
    } catch (err) {
      return { content: String(err), isError: true };
    }
  });

  // ── state_delete ─────────────────────────────────────────────────────────

  handlers.set('state_delete', async (input) => {
    try {
      const { namespace, key } = DeleteInput.parse(input);
      const result = store.del(namespace, key);
      return { content: JSON.stringify(result) };
    } catch (err) {
      return { content: String(err), isError: true };
    }
  });

  // ── state_query ──────────────────────────────────────────────────────────

  handlers.set('state_query', async (input) => {
    try {
      const parsed = QueryInput.parse(input);
      // Clamp limit to 100; default to 20.
      const limit = Math.min(parsed.limit ?? 20, 100);
      const result = store.query(parsed.namespace, {
        key_prefix: parsed.key_prefix,
        limit,
      });
      return { content: JSON.stringify(result) };
    } catch (err) {
      return { content: String(err), isError: true };
    }
  });

  return handlers;
}
