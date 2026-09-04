/**
 * Tool schema definitions for the durable cross-session state store.
 *
 * Five tools: state_get, state_put, state_cas, state_delete, state_query.
 * Follows the exact pattern of memory-tools.ts tool definitions.
 *
 * @module agent/state/state-schemas
 */

import type { AnthropicToolDef } from '../tools/types.js';

/**
 * state_get: Retrieve a document from the durable cross-session state store.
 * Returns null if the document does not exist or has expired.
 */
export const stateGetTool: AnthropicToolDef = {
  name: 'state_get',
  category: 'read',
  concurrencySafe: true,
  description:
    'Retrieve a document from the durable cross-session state store. ' +
    'Returns null if the document does not exist or has expired. ' +
    'Documents are namespaced (namespace + key) JSON values with a version counter.',
  input_schema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description:
          'Document namespace. Pattern: [A-Za-z0-9_.-]+, max 128 chars. ' +
          'Use a consistent namespace per concern (e.g. "todos", "project-state").',
      },
      key: {
        type: 'string',
        description: 'Document key. Same pattern/limit as namespace.',
      },
    },
    required: ['namespace', 'key'],
  },
};

/**
 * state_put: Write or update a document in the durable cross-session state store.
 * Creates the document on first write (version=1) and increments version on updates.
 */
export const statePutTool: AnthropicToolDef = {
  name: 'state_put',
  category: 'write',
  concurrencySafe: false,
  description:
    'Write or update a document in the durable cross-session state store. ' +
    'Creates on first insert (version starts at 1) and increments version on updates. ' +
    'Use state_cas instead when concurrent writes are a concern.',
  input_schema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'Document namespace. Pattern: [A-Za-z0-9_.-]+, max 128 chars.',
      },
      key: {
        type: 'string',
        description: 'Document key. Same pattern/limit as namespace.',
      },
      value: {
        description:
          'JSON-serializable value to store. Any JSON type is accepted ' +
          '(object, array, string, number, boolean, null).',
      },
      ttl_ms: {
        type: 'number',
        description:
          'Optional time-to-live in milliseconds. Document is automatically ' +
          'deleted after this many ms from the write time.',
      },
      metadata: {
        description: 'Optional metadata object (JSON-serializable). Not returned by state_get — for audit/tagging only.',
      },
    },
    required: ['namespace', 'key', 'value'],
  },
};

/**
 * state_cas: Compare-and-swap write to the durable cross-session state store.
 * Updates only when the document's current version matches expected_version.
 */
export const stateCasTool: AnthropicToolDef = {
  name: 'state_cas',
  category: 'write',
  concurrencySafe: false,
  description:
    'Compare-and-swap write to the durable cross-session state store. ' +
    'Updates the document only when its current version matches expected_version. ' +
    'Returns {matched: false} if the version does not match or the document does not exist. ' +
    'Use this for safe concurrent updates by multiple sessions.',
  input_schema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'Document namespace. Pattern: [A-Za-z0-9_.-]+, max 128 chars.',
      },
      key: {
        type: 'string',
        description: 'Document key. Same pattern/limit as namespace.',
      },
      expected_version: {
        type: 'number',
        description: 'Version the document must currently have for the update to succeed.',
      },
      value: {
        description: 'New JSON-serializable value to store if the CAS matches.',
      },
      ttl_ms: {
        type: 'number',
        description: 'Optional TTL in milliseconds from the write time.',
      },
      metadata: {
        description: 'Optional metadata object (JSON-serializable).',
      },
    },
    required: ['namespace', 'key', 'expected_version', 'value'],
  },
};

/**
 * state_delete: Delete a document from the durable cross-session state store.
 */
export const stateDeleteTool: AnthropicToolDef = {
  name: 'state_delete',
  category: 'write',
  concurrencySafe: false,
  description:
    'Delete a document from the durable cross-session state store. ' +
    'Returns {deleted: true} if the document existed and was removed, ' +
    '{deleted: false} if it did not exist.',
  input_schema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'Document namespace. Pattern: [A-Za-z0-9_.-]+, max 128 chars.',
      },
      key: {
        type: 'string',
        description: 'Document key. Same pattern/limit as namespace.',
      },
    },
    required: ['namespace', 'key'],
  },
};

/**
 * state_query: List documents in a namespace from the durable cross-session state store.
 */
export const stateQueryTool: AnthropicToolDef = {
  name: 'state_query',
  category: 'read',
  concurrencySafe: true,
  description:
    'List documents in a namespace from the durable cross-session state store. ' +
    'Returns documents sorted by key. Supports key prefix filtering and pagination. ' +
    'Expired documents are excluded. Default limit is 20, maximum is 100.',
  input_schema: {
    type: 'object',
    properties: {
      namespace: {
        type: 'string',
        description: 'Document namespace. Pattern: [A-Za-z0-9_.-]+, max 128 chars.',
      },
      key_prefix: {
        type: 'string',
        description: 'Optional key prefix filter. Only documents whose key starts with this string are returned.',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results to return (default 20, max 100).',
      },
    },
    required: ['namespace'],
  },
};

/** All five state tool schemas. */
export const stateToolSchemas: AnthropicToolDef[] = [
  stateGetTool,
  statePutTool,
  stateCasTool,
  stateDeleteTool,
  stateQueryTool,
];

/** Read-only state tool schemas (for read-only session contexts). */
export const stateReadToolSchemas: AnthropicToolDef[] = [stateGetTool, stateQueryTool];
