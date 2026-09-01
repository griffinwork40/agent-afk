/**
 * Tool schema for the `test_run` built-in tool.
 *
 * Extracted from `schemas.ts` to satisfy the 350-line ceiling ratchet
 * (baselined files may shrink, never grow). Imported and registered in
 * `builtinToolSchemas[]` by the parent module.
 *
 * @module agent/tools/schemas.test-run
 */

import type { AnthropicToolDef } from './types.js';

export const testRunTool: AnthropicToolDef = {
  name: 'test_run',
  category: 'shell',
  concurrencySafe: false,
  description:
    'Discover and run the project test suite. Auto-detects the test command ' +
    'from project config files (package.json scripts, pyproject.toml, Cargo.toml, ' +
    'go.mod, Gemfile+spec/, Makefile). Optionally narrows to a specific file or ' +
    'test name using runner-specific syntax (handled automatically). Returns ' +
    'structured results with pass/fail counts, per-failure details, duration, and ' +
    'the raw output. Use instead of bash for test invocations — it provides ' +
    'structured testResult metadata that consumers (traces, hooks) can act on.',
  input_schema: {
    type: 'object',
    properties: {
      file: {
        type: 'string',
        description: 'Narrow to a specific test file path (relative to project root)',
      },
      name: {
        type: 'string',
        description:
          'Filter tests by name/pattern. Runner-specific syntax is applied ' +
          'automatically: vitest/jest use --testNamePattern, pytest uses -k, ' +
          'go test uses -run, rspec uses --example, cargo test uses the name directly.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Test timeout in ms (default: 120000, max: 600000)',
      },
      coverage: {
        type: 'boolean',
        description: 'Request coverage report (adds runner-specific coverage flags)',
      },
    },
    required: [],
  },
};
