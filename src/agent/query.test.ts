/**
 * Tests for the library-facing one-shot entry points (`query` / `queryText`).
 *
 * Uses the shared mock ModelProvider (injected via `provider`) so no real SDK is
 * touched. The key contract under test: the wrappers own the session lifecycle —
 * they must construct a session, stream/return its result, and ALWAYS close the
 * underlying provider query (normal completion, early break, and the
 * non-streaming path).
 */

import { describe, it, expect, vi } from 'vitest';
import { createMockProvider } from './__fixtures__/mock-provider.js';
import { query, queryText } from './query.js';
import type { OutputEvent } from './types.js';

vi.mock('../utils/debug.js', () => ({ debugLog: vi.fn() }));

describe('query()', () => {
  it('streams output events and closes the session on completion', async () => {
    const provider = createMockProvider();
    const events: OutputEvent[] = [];
    for await (const event of query('hello', { provider, apiKey: 'test-key' })) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThan(0);
    expect(provider.queries).toHaveLength(1);
    expect(provider.queries[0]!.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it('defaults the model when none is supplied (no throw on construction)', async () => {
    const provider = createMockProvider();
    const events: OutputEvent[] = [];
    for await (const event of query('hi', { provider, apiKey: 'test-key' })) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThan(0);
    expect(provider.queries[0]!.closeCalls).toBeGreaterThanOrEqual(1);
  });

  it('closes the session even when the caller breaks early', async () => {
    const provider = createMockProvider();
    const seen: OutputEvent[] = [];
    for await (const event of query('hello', { provider, apiKey: 'test-key' })) {
      seen.push(event);
      break; // generator return → finally → close()
    }
    expect(seen.length).toBe(1);
    expect(provider.queries[0]!.closeCalls).toBeGreaterThanOrEqual(1);
  });
});

describe('queryText()', () => {
  it('resolves to the final assistant text and closes the session', async () => {
    const provider = createMockProvider();
    const text = await queryText('world', { provider, apiKey: 'test-key' });
    // The mock provider echoes the prompt back as the assistant message.
    expect(text).toContain('world');
    expect(provider.queries[0]!.closeCalls).toBeGreaterThanOrEqual(1);
  });
});
