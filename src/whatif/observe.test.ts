/**
 * Tests for `src/whatif/observe.ts`.
 *
 * All tests are deterministic and pure — no I/O, no model calls.
 */

import { describe, expect, it } from 'vitest';
import {
  FEATURE_LABELS,
  extractFeatures,
  featureIndicators,
  meanResponseChars,
  meanToolCalls,
} from './observe.js';
import type { EpisodeTrace } from './types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTrace(partial: Partial<EpisodeTrace>): EpisodeTrace {
  return {
    episodeId: 'e1',
    env: 'baseline',
    sample: 0,
    text: '',
    tools: [],
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    durationMs: 0,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// firstAction classification
// ---------------------------------------------------------------------------

describe('extractFeatures – firstAction', () => {
  it('none: no tools and empty text', () => {
    const f = extractFeatures(makeTrace({ text: '', tools: [] }));
    expect(f.firstAction).toBe('none');
  });

  it('answer: no tools but has text', () => {
    const f = extractFeatures(makeTrace({ text: 'Here is my answer.', tools: [] }));
    expect(f.firstAction).toBe('answer');
  });

  it('ask: first tool is ask_question', () => {
    const f = extractFeatures(
      makeTrace({
        tools: [{ tool: 'ask_question', input: {}, verdict: 'executed' }],
      }),
    );
    expect(f.firstAction).toBe('ask');
  });

  it('delegate: first tool is agent', () => {
    const f = extractFeatures(
      makeTrace({
        tools: [{ tool: 'agent', input: {}, verdict: 'executed' }],
      }),
    );
    expect(f.firstAction).toBe('delegate');
  });

  it('delegate: first tool is skill', () => {
    const f = extractFeatures(
      makeTrace({
        tools: [{ tool: 'skill', input: { name: 'diagnose' }, verdict: 'executed' }],
      }),
    );
    expect(f.firstAction).toBe('delegate');
  });

  it('delegate: first tool is compose', () => {
    const f = extractFeatures(
      makeTrace({
        tools: [{ tool: 'compose', input: {}, verdict: 'executed' }],
      }),
    );
    expect(f.firstAction).toBe('delegate');
  });

  it('side-effect: first tool is recorded', () => {
    const f = extractFeatures(
      makeTrace({
        tools: [{ tool: 'bash', input: { command: 'rm -rf /' }, verdict: 'recorded' }],
      }),
    );
    expect(f.firstAction).toBe('side-effect');
  });

  it('side-effect: recorded precedes executed', () => {
    const f = extractFeatures(
      makeTrace({
        tools: [
          { tool: 'read_file', input: {}, verdict: 'executed' },
          { tool: 'write_file', input: {}, verdict: 'recorded' },
          { tool: 'bash', input: {}, verdict: 'executed' },
        ],
      }),
    );
    // First tool is executed → initially 'read', then re-scan finds recorded after an executed.
    // Actually re-scan breaks at first executed, so this stays 'read'.
    expect(f.firstAction).toBe('read');
  });

  it('side-effect: recorded before any executed', () => {
    const f = extractFeatures(
      makeTrace({
        tools: [
          { tool: 'write_file', input: {}, verdict: 'recorded' },
          { tool: 'read_file', input: {}, verdict: 'executed' },
        ],
      }),
    );
    expect(f.firstAction).toBe('side-effect');
  });

  it('read: first tool executed (non-ask, non-delegate)', () => {
    const f = extractFeatures(
      makeTrace({
        tools: [{ tool: 'read_file', input: {}, verdict: 'executed' }],
      }),
    );
    expect(f.firstAction).toBe('read');
  });
});

// ---------------------------------------------------------------------------
// askedBeforeActing
// ---------------------------------------------------------------------------

describe('extractFeatures – askedBeforeActing', () => {
  it('true: no tools, last line ends with ?', () => {
    const f = extractFeatures(makeTrace({ text: 'Sure.\nWhat do you mean by that?' }));
    expect(f.askedBeforeActing).toBe(true);
  });

  it('false: no tools, last line does not end with ?', () => {
    const f = extractFeatures(makeTrace({ text: 'Done.' }));
    expect(f.askedBeforeActing).toBe(false);
  });

  it('true: ask_question before any recorded', () => {
    const f = extractFeatures(
      makeTrace({
        tools: [
          { tool: 'ask_question', input: {}, verdict: 'executed' },
          { tool: 'bash', input: {}, verdict: 'recorded' },
        ],
      }),
    );
    expect(f.askedBeforeActing).toBe(true);
  });

  it('false: recorded before ask_question', () => {
    const f = extractFeatures(
      makeTrace({
        tools: [
          { tool: 'bash', input: {}, verdict: 'recorded' },
          { tool: 'ask_question', input: {}, verdict: 'executed' },
        ],
      }),
    );
    expect(f.askedBeforeActing).toBe(false);
  });

  it('false: no ask, just executed tools', () => {
    const f = extractFeatures(
      makeTrace({
        tools: [{ tool: 'read_file', input: {}, verdict: 'executed' }],
      }),
    );
    expect(f.askedBeforeActing).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// usedSkills
// ---------------------------------------------------------------------------

describe('extractFeatures – usedSkills', () => {
  it('collects skill tool names', () => {
    const f = extractFeatures(
      makeTrace({
        tools: [
          { tool: 'skill', input: { name: 'diagnose' }, verdict: 'executed' },
          { tool: 'skill', input: { name: 'mint' }, verdict: 'executed' },
        ],
      }),
    );
    expect(f.usedSkills).toEqual(['diagnose', 'mint']);
  });

  it('empty when no skill calls', () => {
    const f = extractFeatures(makeTrace({ tools: [{ tool: 'bash', input: {}, verdict: 'executed' }] }));
    expect(f.usedSkills).toEqual([]);
  });

  it('ignores skill calls with non-string name', () => {
    const f = extractFeatures(
      makeTrace({
        tools: [{ tool: 'skill', input: { name: 123 }, verdict: 'executed' }],
      }),
    );
    expect(f.usedSkills).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// searchedMemory
// ---------------------------------------------------------------------------

describe('extractFeatures – searchedMemory', () => {
  it('true when memory_search is used', () => {
    const f = extractFeatures(
      makeTrace({
        tools: [{ tool: 'memory_search', input: { query: 'pnpm' }, verdict: 'executed' }],
      }),
    );
    expect(f.searchedMemory).toBe(true);
  });

  it('false when memory_search is absent', () => {
    const f = extractFeatures(makeTrace({ tools: [] }));
    expect(f.searchedMemory).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// errored
// ---------------------------------------------------------------------------

describe('extractFeatures – errored', () => {
  it('true when error field is set', () => {
    const f = extractFeatures(makeTrace({ error: 'subprocess timed out' }));
    expect(f.errored).toBe(true);
  });

  it('false when error is absent', () => {
    const f = extractFeatures(makeTrace({}));
    expect(f.errored).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// delegated
// ---------------------------------------------------------------------------

describe('extractFeatures – delegated', () => {
  it('true when agent tool appears anywhere', () => {
    const f = extractFeatures(
      makeTrace({
        tools: [
          { tool: 'read_file', input: {}, verdict: 'executed' },
          { tool: 'agent', input: {}, verdict: 'executed' },
        ],
      }),
    );
    expect(f.delegated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// FEATURE_LABELS + featureIndicators
// ---------------------------------------------------------------------------

describe('FEATURE_LABELS', () => {
  it('has 6 entries', () => {
    expect(FEATURE_LABELS.length).toBe(6);
  });
});

describe('featureIndicators', () => {
  it('all keys match FEATURE_LABELS', () => {
    const f = extractFeatures(makeTrace({}));
    const indicators = featureIndicators(f);
    const keys = Object.keys(indicators).sort();
    const labels = [...FEATURE_LABELS].sort();
    expect(keys).toEqual(labels);
  });

  it('maps askedBeforeActing correctly', () => {
    const f = extractFeatures(makeTrace({ text: 'Are you sure?' }));
    const indicators = featureIndicators(f);
    expect(indicators['Asked before acting']).toBe(true);
  });

  it('maps errored correctly', () => {
    const f = extractFeatures(makeTrace({ error: 'boom' }));
    const indicators = featureIndicators(f);
    expect(indicators['Hit an error']).toBe(true);
  });

  it('maps side-effect correctly', () => {
    const f = extractFeatures(
      makeTrace({ tools: [{ tool: 'bash', input: {}, verdict: 'recorded' }] }),
    );
    const indicators = featureIndicators(f);
    expect(indicators['Took a side-effecting action']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// meanNumeric helpers
// ---------------------------------------------------------------------------

describe('meanToolCalls / meanResponseChars', () => {
  it('returns 0 for empty array', () => {
    expect(meanToolCalls([])).toBe(0);
    expect(meanResponseChars([])).toBe(0);
  });

  it('computes mean correctly', () => {
    const traces = [makeTrace({ tools: [{ tool: 'x', input: {}, verdict: 'executed' }] }), makeTrace({ tools: [] })];
    const features = traces.map(extractFeatures);
    expect(meanToolCalls(features)).toBe(0.5);
  });

  it('responseChars mean', () => {
    const traces = [makeTrace({ text: 'ab' }), makeTrace({ text: 'abcd' })];
    const features = traces.map(extractFeatures);
    expect(meanResponseChars(features)).toBe(3);
  });
});
