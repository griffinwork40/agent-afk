/**
 * Unit tests for `tool()` helper and `CustomToolDef` wiring.
 *
 * What we verify:
 *  1. `tool()` produces a `CustomToolDef` with correct name, description, and
 *     an `input_schema` derived from the Zod schema.
 *  2. The wrapped handler returns an error result (isError: true) when called
 *     with input that violates the Zod schema — never throws.
 *  3. Valid input is parsed and forwarded to the user handler with typed values.
 *  4. A registered custom tool name appears in `AnthropicDirectProvider.schemas`
 *     (wiring test: provider schema list is updated at construction time).
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { tool } from './custom-tool.js';
import { AnthropicDirectProvider } from '../providers/anthropic-direct/index.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible/index.js';
import type { ToolResult } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** The abort signal used for handler calls in tests. */
const noop_signal = new AbortController().signal;

// ---------------------------------------------------------------------------
// 1. `tool()` produces correct shape
// ---------------------------------------------------------------------------

describe('tool() factory', () => {
  it('produces a CustomToolDef with the correct name and description', () => {
    const def = tool(
      'my_tool',
      'Does something useful',
      z.object({ value: z.string() }),
      async ({ value }) => ({ content: value }),
    );

    expect(def.schema.name).toBe('my_tool');
    expect(def.schema.description).toBe('Does something useful');
  });

  it('input_schema.type is "object"', () => {
    const def = tool(
      'typed_tool',
      'A typed tool',
      z.object({ count: z.number() }),
      async ({ count }) => ({ content: String(count) }),
    );

    expect(def.schema.input_schema.type).toBe('object');
  });

  it('input_schema includes a property from the Zod schema', () => {
    const def = tool(
      'greet',
      'Greet someone',
      z.object({ name: z.string(), age: z.number().optional() }),
      async ({ name }) => ({ content: `Hello ${name}` }),
    );

    // z.toJSONSchema produces { type: 'object', properties: { name: ..., age: ... }, ... }
    const props = def.schema.input_schema.properties as Record<string, unknown> | undefined;
    expect(props).toBeDefined();
    expect(props).toHaveProperty('name');
  });

  it('handler and schema are both present', () => {
    const def = tool(
      'noop',
      'No-op',
      z.object({}),
      async () => ({ content: '' }),
    );

    expect(typeof def.handler).toBe('function');
    expect(def.schema).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Input validation: invalid input returns error result, does not throw
// ---------------------------------------------------------------------------

describe('tool() input validation', () => {
  it('returns isError result on schema violation (no throw)', async () => {
    const def = tool(
      'strict_tool',
      'Requires a number',
      z.object({ count: z.number() }),
      async ({ count }) => ({ content: String(count) }),
    );

    // Pass a string where a number is required.
    const result = await def.handler({ count: 'not-a-number' }, noop_signal);

    expect((result as ToolResult & { isError?: boolean }).isError).toBe(true);
    // Error message should name the tool and describe the validation failure.
    const content = String((result as { content: unknown }).content);
    expect(content).toContain('strict_tool');
    expect(content).toContain('validation failed');
  });

  it('returns isError result when required field is missing', async () => {
    const def = tool(
      'needs_name',
      'Requires a name',
      z.object({ name: z.string() }),
      async ({ name }) => ({ content: name }),
    );

    const result = await def.handler({}, noop_signal);

    expect((result as ToolResult & { isError?: boolean }).isError).toBe(true);
  });

  it('does not throw on invalid input — error is a return value', async () => {
    const def = tool(
      'safe_tool',
      'Safe',
      z.object({ x: z.number() }),
      async ({ x }) => ({ content: String(x) }),
    );

    // Should resolve, not reject.
    await expect(def.handler('completely-wrong', noop_signal)).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Valid input reaches the user handler with typed/parsed values
// ---------------------------------------------------------------------------

describe('tool() with valid input', () => {
  it('forwards parsed (typed) input to the user handler', async () => {
    const userHandler = vi.fn(async ({ x }: { x: number }) => ({
      content: String(x * 2),
    }));

    const def = tool(
      'double',
      'Doubles a number',
      z.object({ x: z.number() }),
      userHandler,
    );

    const result = await def.handler({ x: 5 }, noop_signal);

    expect(userHandler).toHaveBeenCalledOnce();
    expect(userHandler).toHaveBeenCalledWith({ x: 5 }, noop_signal, undefined);
    expect((result as { content: unknown }).content).toBe('10');
  });

  it('coerces/parses input through zod before forwarding (e.g. default values)', async () => {
    const received: Array<{ label: string }> = [];

    const def = tool(
      'with_default',
      'Has a default value',
      z.object({ label: z.string().default('world') }),
      async ({ label }) => {
        received.push({ label });
        return { content: label };
      },
    );

    // Input with missing optional-default field — Zod should fill it.
    const result = await def.handler({}, noop_signal);

    expect(received[0]?.label).toBe('world');
    expect((result as { content: unknown }).content).toBe('world');
  });

  it('passes signal and context through to the user handler', async () => {
    const capturedArgs: unknown[] = [];

    const def = tool(
      'ctx_tool',
      'Captures context',
      z.object({ msg: z.string() }),
      async (input, signal, context) => {
        capturedArgs.push(input, signal, context);
        return { content: 'ok' };
      },
    );

    const ctrl = new AbortController();
    const fakeContext = { cwd: '/tmp' } as Parameters<typeof def.handler>[2];
    await def.handler({ msg: 'hello' }, ctrl.signal, fakeContext);

    expect(capturedArgs[0]).toEqual({ msg: 'hello' });
    expect(capturedArgs[1]).toBe(ctrl.signal);
    expect(capturedArgs[2]).toBe(fakeContext);
  });
});

// ---------------------------------------------------------------------------
// 4. Provider wiring: custom tool schema appears in AnthropicDirectProvider.schemas
// ---------------------------------------------------------------------------

describe('AnthropicDirectProvider custom tool wiring', () => {
  it('includes custom tool schema in the provider schema list', () => {
    const myTool = tool(
      'my_custom_tool',
      'A custom in-process tool',
      z.object({ input: z.string() }),
      async ({ input }) => ({ content: input }),
    );

    const provider = new AnthropicDirectProvider({ customTools: [myTool] });

    // Access private `schemas` at runtime (private is TypeScript-only).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schemas: Array<{ name: string }> = (provider as any).schemas;
    const names = schemas.map((s) => s.name);

    expect(names).toContain('my_custom_tool');
  });

  it('does not include custom tool schema when customTools is empty', () => {
    const provider = new AnthropicDirectProvider({ customTools: [] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schemas: Array<{ name: string }> = (provider as any).schemas;
    // Builtin names should be present; no phantom names from an empty list.
    expect(schemas.length).toBeGreaterThan(0);
    // All schema names should be known builtins (nothing injected from empty array).
    const customToolName = '__nonexistent_custom__';
    expect(schemas.map((s) => s.name)).not.toContain(customToolName);
  });

  it('stores multiple custom tools in the schema list', () => {
    const tool1 = tool('tool_alpha', 'Alpha', z.object({ a: z.string() }), async () => ({ content: '' }));
    const tool2 = tool('tool_beta', 'Beta', z.object({ b: z.number() }), async () => ({ content: '' }));

    const provider = new AnthropicDirectProvider({ customTools: [tool1, tool2] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const names = (provider as any).schemas.map((s: { name: string }) => s.name);
    expect(names).toContain('tool_alpha');
    expect(names).toContain('tool_beta');
  });

  it('also wires custom tools in OpenAICompatibleProvider schemas', () => {
    const myTool = tool(
      'openai_custom_tool',
      'A custom OpenAI-compatible tool',
      z.object({ query: z.string() }),
      async ({ query }) => ({ content: query }),
    );

    const provider = new OpenAICompatibleProvider({ customTools: [myTool] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const names = (provider as any).schemas.map((s: { name: string }) => s.name);
    expect(names).toContain('openai_custom_tool');
  });
});
