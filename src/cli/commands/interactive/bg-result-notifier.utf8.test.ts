/**
 * UTF-8 boundary tests for bg-result-notifier truncation (issue #4770).
 *
 * The existing bg-result-notifier.test.ts uses only ASCII payloads in its
 * truncation scenarios. This file verifies that the U+FFFD replacement-
 * character guard in `truncateBytes` works correctly when the byte-cap
 * boundary lands mid-way through a multi-byte UTF-8 codepoint.
 *
 * Strategy: craft a string where a multi-byte codepoint straddles the
 * MAX_INJECTION_BYTES boundary, then confirm the injection envelope
 * contains no trailing U+FFFD in the output section and still stays
 * well-formed (exactly one opening and one closing envelope tag).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { BackgroundAgentRegistry } from '../../../agent/background-registry.js';
import type { SubagentHandle, SubagentResult } from '../../../agent/subagent.js';
import {
  BgResultNotifier,
  MAX_INJECTION_BYTES,
} from './bg-result-notifier.js';

// Silence routing-telemetry side effects.
vi.mock('../../../agent/routing-telemetry.js', () => ({
  appendRoutingDecision: vi.fn(async () => {}),
}));

function makeBgHandle(id = 'sub-utf8'): {
  handle: SubagentHandle;
  fireTerminal: (r: SubagentResult) => void;
} {
  let captured: ((r: SubagentResult) => void) | undefined;
  return {
    handle: {
      id,
      status: 'idle',
      runInBackground: vi.fn((_p: string, on?: (r: SubagentResult) => void) => {
        captured = on;
      }),
      cancel: vi.fn().mockResolvedValue(undefined),
      teardown: vi.fn().mockResolvedValue(undefined),
      run: vi.fn(),
      runToResult: vi.fn(),
    } as unknown as SubagentHandle,
    fireTerminal: (r) => captured?.(r),
  };
}

function succeed(id: string, content: string): SubagentResult {
  return {
    id,
    status: 'succeeded',
    message: { content, role: 'assistant' } as unknown as SubagentResult['message'],
  } as SubagentResult;
}

// ---------------------------------------------------------------------------
// U+FFFD guard tests
// ---------------------------------------------------------------------------

describe('BgResultNotifier — U+FFFD guard at multi-byte truncation boundary', () => {
  let registry: BackgroundAgentRegistry;
  let notifier: BgResultNotifier;

  beforeEach(() => {
    vi.unstubAllEnvs();
    registry = new BackgroundAgentRegistry({});
    notifier = new BgResultNotifier(registry);
  });

  afterEach(() => {
    notifier.dispose();
    vi.unstubAllEnvs();
  });

  it('strips trailing U+FFFD when a 2-byte codepoint straddles the byte cap', () => {
    // Build a string that is exactly MAX_INJECTION_BYTES bytes of ASCII
    // followed by the first byte of a 2-byte UTF-8 sequence (0xC3 = start
    // of characters like é). After escaping (no < > & in this payload),
    // truncateBytes will slice at MAX_INJECTION_BYTES, leaving the lone 0xC3
    // which Buffer.toString converts to U+FFFD. The guard must strip it.
    //
    // We need the escaped string to straddle the boundary, not the raw string.
    // Since this payload has no special XML chars, escaped === raw.
    const ascii = 'a'.repeat(MAX_INJECTION_BYTES - 1);
    // Append U+00E9 (é = 0xC3 0xA9) so the first byte of its encoding lands
    // at position MAX_INJECTION_BYTES-1 and the second at MAX_INJECTION_BYTES.
    const payload = ascii + '\u00e9'; // é is 2 bytes in UTF-8

    const { handle, fireTerminal } = makeBgHandle('sub-utf8-2b');
    registry.register({ handle, prompt: 'utf8-test', model: 'sonnet' });
    fireTerminal(succeed('sub-utf8-2b', payload));

    const injection = notifier.drainInjections();

    // Envelope must be well-formed.
    expect(injection.match(/<background-subagent-result /g)).toHaveLength(1);
    expect(injection.match(/<\/background-subagent-result>/g)).toHaveLength(1);

    // No trailing U+FFFD in the output section.
    // Extract the <output>…</output> region and verify it has no FFFD.
    const outputMatch = /<output>([\s\S]*?)<\/output>/.exec(injection);
    expect(outputMatch).not.toBeNull();
    expect(outputMatch![1]).not.toContain('\uFFFD');

    // Byte size must be capped.
    expect(Buffer.byteLength(injection, 'utf8')).toBeLessThan(MAX_INJECTION_BYTES + 1024);
  });

  it('strips trailing U+FFFD when a 3-byte codepoint straddles the byte cap', () => {
    // U+4E2D (中) encodes as 3 bytes: 0xE4 0xB8 0xAD.
    // Place it so that only 1 or 2 of its bytes fall inside the cap window.
    const ascii = 'a'.repeat(MAX_INJECTION_BYTES - 2);
    // Append 中 (3 bytes): bytes at positions -2, -1, 0 relative to cap.
    // Position -2 and -1 land inside the cap; byte 0 is cut off.
    const payload = ascii + '\u4e2d';

    const { handle, fireTerminal } = makeBgHandle('sub-utf8-3b');
    registry.register({ handle, prompt: 'utf8-test-3b', model: 'sonnet' });
    fireTerminal(succeed('sub-utf8-3b', payload));

    const injection = notifier.drainInjections();

    expect(injection.match(/<\/background-subagent-result>/g)).toHaveLength(1);

    const outputMatch = /<output>([\s\S]*?)<\/output>/.exec(injection);
    expect(outputMatch).not.toBeNull();
    expect(outputMatch![1]).not.toContain('\uFFFD');

    expect(Buffer.byteLength(injection, 'utf8')).toBeLessThan(MAX_INJECTION_BYTES + 1024);
  });

  it('handles a payload of pure multi-byte characters correctly at the cap', () => {
    // A string of Japanese characters (3 bytes each). Some will be cut mid-
    // sequence at the byte cap; the guard must strip any resulting U+FFFD.
    const japanese = '日'.repeat(Math.ceil((MAX_INJECTION_BYTES + 100) / 3));

    const { handle, fireTerminal } = makeBgHandle('sub-utf8-jp');
    registry.register({ handle, prompt: 'japanese', model: 'sonnet' });
    fireTerminal(succeed('sub-utf8-jp', japanese));

    const injection = notifier.drainInjections();

    expect(injection.match(/<\/background-subagent-result>/g)).toHaveLength(1);

    const outputMatch = /<output>([\s\S]*?)<\/output>/.exec(injection);
    expect(outputMatch).not.toBeNull();
    expect(outputMatch![1]).not.toContain('\uFFFD');

    expect(Buffer.byteLength(injection, 'utf8')).toBeLessThan(MAX_INJECTION_BYTES + 1024);
  });
});
