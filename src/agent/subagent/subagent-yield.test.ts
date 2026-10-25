/**
 * Tests for subagent yield (needs_input) detection.
 *
 * Verifies that when a child ends its turn with an Asking terminal-state block,
 * `buildResultFromMessage` sets `needsInput` with the parsed question, and that
 * schema errors are cleared for yielding children.
 *
 * @module agent/subagent/subagent-yield.test
 */

import { describe, it, expect } from 'vitest';
import { buildResultFromMessage } from './result.js';
import type { Message } from '../types.js';
import { z } from 'zod';

function makeMessage(content: string): Message {
  return { role: 'assistant', content, timestamp: new Date() };
}

describe('buildResultFromMessage needsInput detection', () => {
  it('sets needsInput when child ends with an Asking block', () => {
    const msg = makeMessage(
      'I did some work.\n\n' +
      '**Asking**\n' +
      '- Question: What is the target environment?\n' +
      '- Assumption it resolves: Whether to build for prod or staging\n' +
      '- Once answered: I will finish the deployment config\n',
    );
    const result = buildResultFromMessage('child-1', 'succeeded', msg, undefined);
    expect(result.needsInput).toBeDefined();
    expect(result.needsInput?.question).toBe('What is the target environment?');
    expect(result.needsInput?.assumption).toContain('prod or staging');
    expect(result.needsInput?.onceAnswered).toContain('deployment config');
  });

  it('does not set needsInput for a normal Done message', () => {
    const msg = makeMessage(
      'All done.\n\n' +
      '**Done**\n' +
      '- What was done: Wrote the tests\n',
    );
    const result = buildResultFromMessage('child-2', 'succeeded', msg, undefined);
    expect(result.needsInput).toBeUndefined();
  });

  it('does not set needsInput when Asking appears mid-body (not in tail)', () => {
    // 50 lines of content push the Asking heading outside the 40-line tail window
    const filler = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`).join('\n');
    const msg = makeMessage(
      '**Asking**\n- Question: Old question\n\n' +
      filler + '\n\n' +
      '**Done**\n- What was done: Finished\n',
    );
    const result = buildResultFromMessage('child-3', 'succeeded', msg, undefined);
    // The Done heading is in the tail so terminal-state resolves to 'done'
    expect(result.needsInput).toBeUndefined();
  });

  it('clears a spurious schema error when needsInput is set', () => {
    const schema = z.object({ answer: z.string() });
    const msg = makeMessage(
      'No structured output here.\n\n' +
      '**Asking**\n' +
      '- Question: Which branch should I target?\n' +
      '- Assumption it resolves: The PR base\n' +
      '- Once answered: I will open the PR\n',
    );
    // Without yield detection this would resolve status:'failed' + schemaError.
    // With yield detection the schema error must be cleared.
    const result = buildResultFromMessage('child-4', 'succeeded', msg, schema);
    expect(result.needsInput).toBeDefined();
    expect(result.needsInput?.question).toBe('Which branch should I target?');
    expect(result.schemaError).toBeUndefined();
    expect(result.status).not.toBe('failed');
  });

  it('returns undefined needsInput when Question bullet is absent (SEC-2)', () => {
    const msg = makeMessage(
      'Summary of work.\n\n' +
      '**Asking**\n' +
      'Should I use TypeScript strict mode?\n',
    );
    const result = buildResultFromMessage('child-5', 'succeeded', msg, undefined);
    // SEC-2: missing Question bullet is a malformed yield — rawBody must not
    // be injected as an authoritative question into the parent tool_result.
    expect(result.needsInput).toBeUndefined();
  });

  it('detects needsInput from ContentBlock[] content (F-T1)', () => {
    const blocks = [
      { type: 'thinking', thinking: 'reasoning about the question...' },
      { type: 'text', text: 'I did some work.\n\n**Asking**\n- Question: What database should I use?\n- Assumption it resolves: The persistence layer choice\n- Once answered: I will implement the schema\n' },
    ];
    const msg: Message = { role: 'assistant', content: blocks as never, timestamp: new Date() };
    const result = buildResultFromMessage('child-6', 'succeeded', msg, undefined);
    expect(result.needsInput).toBeDefined();
    expect(result.needsInput?.question).toBe('What database should I use?');
    expect(result.needsInput?.assumption).toContain('persistence layer');
    expect(result.needsInput?.onceAnswered).toContain('implement the schema');
  });
});

describe('renderSubagentIdentityPreamble yieldEnabled', () => {
  it('includes the Asking format paragraph when yieldEnabled is true', async () => {
    const { renderSubagentIdentityPreamble } = await import('./identity-preamble.js');
    const out = renderSubagentIdentityPreamble({
      isNonInteractive: true,
      depth: 1,
      maxDepth: 3,
      yieldEnabled: true,
    });
    expect(out).toContain('**Asking**');
    expect(out).toContain('Question:');
    expect(out).toContain('Assumption it resolves:');
    expect(out).toContain('Once answered:');
    expect(out).toContain('Asking ends your turn');
  });

  it('uses the fallback paragraph when yieldEnabled is false', async () => {
    const { renderSubagentIdentityPreamble } = await import('./identity-preamble.js');
    const out = renderSubagentIdentityPreamble({
      isNonInteractive: true,
      depth: 1,
      maxDepth: 3,
      yieldEnabled: false,
    });
    expect(out).toContain('proceed on the most reasonable assumption');
    expect(out).not.toContain('**Asking**\n- Question:');
  });

  it('uses the fallback paragraph when yieldEnabled is absent', async () => {
    const { renderSubagentIdentityPreamble } = await import('./identity-preamble.js');
    const out = renderSubagentIdentityPreamble({
      isNonInteractive: true,
      depth: 1,
      maxDepth: 3,
    });
    expect(out).toContain('proceed on the most reasonable assumption');
  });
});
