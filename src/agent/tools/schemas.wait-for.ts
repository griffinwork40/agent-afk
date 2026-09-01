/**
 * Tool schema for the `wait_for` built-in.
 *
 * Extracted into its own file to satisfy the 350-code-line ratchet on
 * `schemas.ts` (baselined files may shrink, never grow). Imported and
 * re-exported from `schemas.ts` so callers import from the primary module.
 *
 * @module agent/tools/schemas.wait-for
 */

import type { AnthropicToolDef } from './types.js';

export const waitForTool: AnthropicToolDef = {
  name: 'wait_for',
  category: 'shell',
  concurrencySafe: true,
  description:
    'Block on an external condition without consuming model turns. The poll loop runs in Node. ' +
    'Condition types: ' +
    '"url" — polls an HTTP/HTTPS endpoint until it returns the expected status (default: any 2xx). ' +
    '"file" — waits until a file exists (and optionally contains a substring). ' +
    '"process" — waits until a PID has exited (process.kill(pid, 0) → ESRCH). ' +
    '"command" — runs a shell command repeatedly; exit 0 signals the condition is met. ' +
    'The tool returns when the condition is met, the timeout elapses (status: timed_out), or ' +
    'the session is cancelled (status: cancelled). Timeout is NOT an error — the model can retry. ' +
    'URL waits are SSRF-guarded: private/loopback/link-local/cloud-metadata targets are rejected. ' +
    'Use timeout_ms and poll_interval_ms to tune wait duration and check frequency.',
  input_schema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['url', 'file', 'process', 'command'],
        description:
          'What to wait for: url (HTTP endpoint), file (filesystem path), ' +
          'process (PID exit), or command (shell exit 0).',
      },
      url: {
        type: 'string',
        description: 'For url type: the URL to poll (http/https only).',
      },
      method: {
        type: 'string',
        enum: ['HEAD', 'GET'],
        description: 'HTTP method to use (default: HEAD). Use GET when body_contains is set.',
      },
      expected_status: {
        type: 'number',
        description: 'Expected HTTP status code (default: any 2xx).',
      },
      body_contains: {
        type: 'string',
        description: 'Substring that must appear in the response body. Forces method to GET if unset.',
      },
      path: {
        type: 'string',
        description: 'For file type: absolute or relative path to watch.',
      },
      content_contains: {
        type: 'string',
        description: 'For file type: substring the file content must contain.',
      },
      pid: {
        type: 'number',
        description: 'For process type: PID to wait on. Condition is met when the process exits.',
      },
      command: {
        type: 'string',
        description: 'For command type: shell command to run. Condition is met when it exits 0.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Maximum wait time in milliseconds (default: 120000, max: 600000).',
      },
      poll_interval_ms: {
        type: 'number',
        description: 'Delay between polls in milliseconds (default: 5000, min: 1000).',
      },
      backoff: {
        type: 'string',
        enum: ['none', 'linear', 'exponential'],
        description:
          'Backoff strategy for poll_interval_ms between misses ' +
          '(default: none = fixed interval).',
      },
    },
    required: ['type'],
  },
};
