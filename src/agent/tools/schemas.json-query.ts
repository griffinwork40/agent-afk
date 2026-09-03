/**
 * Tool schema for the `json_query` built-in.
 *
 * Extracted into its own file to satisfy the 350-code-line ratchet on
 * `schemas.ts` (baselined files may shrink, never grow). Imported and
 * re-exported from `schemas.ts` so callers import from the primary module.
 *
 * @module agent/tools/schemas.json-query
 */

import type { AnthropicToolDef } from './types.js';

export const jsonQueryTool: AnthropicToolDef = {
  name: 'json_query',
  category: 'read',
  concurrencySafe: true,
  description:
    'Run a bounded query on a JSON file without loading the full content into model context. ' +
    'Uses a jq-subset syntax to extract fields, array elements, or aggregate values, ' +
    'returning a structured `{ result, type, truncated, source_size }` response.\n\n' +
    'Query syntax (supported subset):\n' +
    '- `.` — return the whole document\n' +
    '- `.field` — access an object field\n' +
    '- `.field.nested` — nested field access\n' +
    '- `.[N]` — array element by index (negative indices count from end)\n' +
    '- `.[N:M]` — array slice from index N to M (exclusive)\n' +
    '- `.[]` — iterate over all array elements\n' +
    '- `.[] | .field` — map over array elements and extract a field from each\n' +
    '- `keys` — list object keys (or array indices)\n' +
    '- `length` — count array elements, object keys, or string characters\n\n' +
    'Results are capped by `max_results` (array element count) and `max_bytes` ' +
    '(serialized output size). When a cap is hit, `truncated` is `true`.',
  input_schema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Absolute or relative path to the JSON file to query.',
      },
      query: {
        type: 'string',
        description:
          'Query expression in jq-subset syntax. ' +
          'Examples: `.` `.name` `.user.profile` `.[0]` `.[1:5]` `.[] | .id` `keys` `length`.',
      },
      max_results: {
        type: 'number',
        description:
          'Maximum number of array elements to return (default 100). ' +
          'When the result is an array longer than this, it is sliced and `truncated` is set.',
      },
      max_bytes: {
        type: 'number',
        description:
          'Maximum serialized output size in bytes (default 51200 = 50 KB). ' +
          'When the serialized result exceeds this, the output is truncated and `truncated` is set.',
      },
    },
    required: ['path', 'query'],
  },
};
