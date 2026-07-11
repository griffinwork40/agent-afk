/**
 * Repeat-loop circuit breaker fingerprinting.
 *
 * Pure helper extracted from `dispatcher.ts` (#361). The stateful breaker
 * (per-dispatcher consecutive-call counter + threshold check) stays on
 * `SessionToolDispatcher`; only the standalone fingerprint function lives here.
 *
 * @module agent/tools/repeat-circuit-breaker
 */

import { createHash } from 'node:crypto';
import type { ToolCall } from '../providers/anthropic-direct/types.js';

/**
 * Stable fingerprint of a tool call for repeat detection: sha256 over
 * `name \0 JSON(input)`. Hashing bounds retained state to 64 hex chars
 * regardless of input size. Identical tool_use blocks from the model
 * serialize identically, so byte-identical calls collide as intended.
 */
export function repeatCallFingerprint(call: ToolCall): string {
  let input: string;
  try {
    input = JSON.stringify(call.input) ?? 'null';
  } catch {
    input = String(call.input);
  }
  return createHash('sha256').update(call.name).update('\u0000').update(input).digest('hex');
}
