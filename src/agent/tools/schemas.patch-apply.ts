/**
 * Tool schema for the patch_apply built-in tool.
 *
 * Extracted from `schemas.ts` to satisfy the 350-line ceiling ratchet
 * (baselined files may shrink, never grow). Imported and re-registered
 * in `builtinToolSchemas[]` by the parent module.
 *
 * @module agent/tools/schemas.patch-apply
 */

import type { AnthropicToolDef } from './types.js';

export const patchApplyTool: AnthropicToolDef = {
  name: 'patch_apply',
  category: 'write',
  concurrencySafe: false,
  description:
    'Validate and atomically apply structured multi-file changes with content-hash ' +
    'verification and dry-run preview. Each change targets a single file and specifies ' +
    'either sequential string replacements (`edits`) or a full replacement (`content`). ' +
    'An optional `expected_hash` (format: "sha256:<hex>") verifies the file has not ' +
    'changed since the hash was computed. ' +
    'Validation runs on ALL files before any write — if any file fails, no files are ' +
    'written and all errors are returned. ' +
    'When `dry_run: true`, returns the unified diff without modifying anything. ' +
    'Writes use temp-file + rename for atomicity; a partial failure triggers best-effort ' +
    'rollback of already-written files.',
  input_schema: {
    type: 'object',
    properties: {
      changes: {
        type: 'array',
        description: 'Array of file changes to apply atomically.',
        items: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'File path (relative or absolute).',
            },
            expected_hash: {
              type: 'string',
              description:
                'SHA-256 hash to verify the file has not changed (format: "sha256:<hex>"). ' +
                'If the file\'s current hash does not match, the entire patch is rejected.',
            },
            edits: {
              type: 'array',
              description:
                'Sequential edits — each `old` string must match exactly once in the file ' +
                '(after previous edits in the same list have been applied).',
              items: {
                type: 'object',
                properties: {
                  old: { type: 'string', description: 'Exact string to find (must occur once).' },
                  new: { type: 'string', description: 'Replacement string.' },
                },
                required: ['old', 'new'],
              },
            },
            content: {
              type: 'string',
              description:
                'Full replacement content for the file. Mutually exclusive with `edits`.',
            },
          },
          required: ['path'],
        },
      },
      dry_run: {
        type: 'boolean',
        description:
          'If true, compute and return the unified diff without writing any files. ' +
          'Default: false.',
      },
    },
    required: ['changes'],
  },
};
