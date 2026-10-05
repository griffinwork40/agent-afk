/**
 * Regression tests for escape-sequence sanitisation in formatOutputEvent.
 *
 * Issue #2445: model-controlled strings (toolName, error.message) were
 * interpolated into the output without being passed through
 * stripEscapeSequences, letting CSI/OSC/DEC-private-mode sequences reach the
 * terminal verbatim.
 *
 * Each test feeds a string carrying one of three representative sequence
 * families and asserts that no raw ESC byte (0x1B) survives in the result.
 * SGR styling added by palette.dim is the only residual source of ESC bytes,
 * so we strip that layer before asserting.
 *
 * @module cli/output-event-format.escape.test
 */

import { describe, it, expect } from 'vitest';
import { formatOutputEvent } from './output-event-format.js';
import type { OutputEvent } from '../agent/types/session-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** SGR pattern: ESC [ <digits/semicolons> m — strip these before asserting. */
// eslint-disable-next-line no-control-regex
const SGR_RE = /\x1B\[[0-9;]*m/g;

/**
 * Strip palette SGR codes so the assertion only fails on non-SGR sequences
 * (the dangerous ones from model/tool-controlled strings).
 */
function stripSgr(s: string): string {
  return s.replace(SGR_RE, '');
}

/** The three representative escape families from the issue. */
const ESCAPE_PAYLOADS = [
  // CSI DEC private mode — ESC [ ? 1049 l  (switch to normal screen buffer)
  '\x1B[?1049l',
  // OSC 52 — clipboard write
  '\x1B]52;c;dGVzdA==\x07',
  // Bare ESC + [  — truncated CSI
  '\x1B[?1049l clean suffix',
];

// ---------------------------------------------------------------------------
// Site 1: tool_use_detail chunk — chunk.toolName
// ---------------------------------------------------------------------------

describe('formatOutputEvent – tool_use_detail toolName sanitisation', () => {
  for (const payload of ESCAPE_PAYLOADS) {
    it(`strips escape sequences from toolName: ${JSON.stringify(payload)}`, () => {
      const event: OutputEvent = {
        type: 'chunk',
        chunk: {
          type: 'tool_use_detail',
          toolUseId: 'use-1',
          toolName: `evil${payload}tool`,
          toolInput: '{}',
        },
      };

      const result = formatOutputEvent(event);
      expect(result).not.toBeNull();
      // Strip SGR styling from palette.dim before asserting — only raw ESC
      // bytes from unsanitised sequences must be absent.
      const bare = stripSgr(result!);
      expect(bare).not.toMatch(/\x1B/);
    });
  }

  it('preserves the clean tool name when no escape sequences are present', () => {
    const event: OutputEvent = {
      type: 'chunk',
      chunk: {
        type: 'tool_use_detail',
        toolUseId: 'use-clean',
        toolName: 'bash',
        toolInput: '{}',
      },
    };
    const result = formatOutputEvent(event);
    expect(result).not.toBeNull();
    const bare = stripSgr(result!);
    expect(bare).toContain('bash');
  });
});

// ---------------------------------------------------------------------------
// Site 2: error branch — event.error.message
// ---------------------------------------------------------------------------

describe('formatOutputEvent – error.message sanitisation', () => {
  for (const payload of ESCAPE_PAYLOADS) {
    it(`strips escape sequences from error.message: ${JSON.stringify(payload)}`, () => {
      const event: OutputEvent = {
        type: 'error',
        error: Object.assign(new Error(`boom${payload}end`), {}),
      };

      const result = formatOutputEvent(event);
      expect(result).not.toBeNull();
      const bare = stripSgr(result!);
      expect(bare).not.toMatch(/\x1B/);
    });
  }

  it('preserves the clean error message when no escape sequences are present', () => {
    const event: OutputEvent = {
      type: 'error',
      error: new Error('connection reset by peer'),
    };
    const result = formatOutputEvent(event);
    expect(result).not.toBeNull();
    const bare = stripSgr(result!);
    expect(bare).toContain('connection reset by peer');
  });
});
