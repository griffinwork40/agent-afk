// Wire-projection tests for the tool definitions the turn loop sends to
// `messages.create`. Before the loop split `toWireTool` had ZERO direct
// coverage — it was exported from loop.ts and imported by nothing, exercised
// only incidentally through full runTurn integration tests. The projection
// guards a real 400 (`tools.0.custom.<field>: Extra inputs are not permitted`),
// so it is pinned directly here.

import { describe, it, expect } from 'vitest';
import { toWireTool } from './round-request.js';
import type { AnthropicToolDef } from '../types.js';

const SCHEMA = {
  type: 'object' as const,
  properties: { path: { type: 'string' } },
  required: ['path'],
};

describe('toWireTool', () => {
  it('strips every internal classification field the wire rejects', () => {
    const internal: AnthropicToolDef = {
      name: 'read_file',
      description: 'Read a file',
      input_schema: SCHEMA,
      category: 'read',
      concurrencySafe: true,
      riskClass: 'safe',
    };

    const wire = toWireTool(internal);

    expect(wire).toEqual({
      name: 'read_file',
      description: 'Read a file',
      input_schema: SCHEMA,
    });
    // Belt-and-braces: assert absence explicitly, since toEqual ignores
    // properties whose value is undefined.
    expect(Object.keys(wire)).not.toContain('category');
    expect(Object.keys(wire)).not.toContain('concurrencySafe');
    expect(Object.keys(wire)).not.toContain('riskClass');
  });

  it('OMITS description entirely when undefined rather than emitting the key', () => {
    const wire = toWireTool({ name: 'noop', input_schema: SCHEMA });

    expect(Object.keys(wire)).toEqual(['name', 'input_schema']);
    expect('description' in wire).toBe(false);
  });

  it('passes input_schema through by reference without cloning or reshaping', () => {
    const internal: AnthropicToolDef = { name: 't', input_schema: SCHEMA };
    expect(toWireTool(internal).input_schema).toBe(SCHEMA);
  });

  it('does not mutate the source definition', () => {
    const internal: AnthropicToolDef = {
      name: 'bash',
      input_schema: SCHEMA,
      category: 'execute',
      concurrencySafe: false,
    };
    const snapshot = structuredClone(internal);

    toWireTool(internal);

    expect(internal).toEqual(snapshot);
  });
});
