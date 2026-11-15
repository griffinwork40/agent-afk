import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OpenAIMessage } from '../messages.js';
import type { TurnDriverContext } from './turn-driver.js';
import { canSynthesizeUnderPressure, windDownForContextPressure } from './context-pressure.js';

afterEach(() => vi.unstubAllEnvs());

function context(turns: OpenAIMessage[], last = 100_000): TurnDriverContext {
  vi.stubEnv('AFK_CONTEXT_GUARD_PCT', '95');
  vi.stubEnv('AFK_CONTEXT_GUARD_DISABLE', undefined);
  return {
    opts: { auth: { source: 'api-key' } }, currentModel: 'gpt-4o-mini',
    lastUsage: { contextWindowTokens: last }, priorTurns: turns,
  } as unknown as TurnDriverContext;
}

function call(argumentsText: string, id = 'write'): OpenAIMessage {
  return { role: 'assistant', content: null, tool_calls: [
    { id, type: 'function', function: { name: 'write_file', arguments: argumentsText } },
  ] };
}

function args(message: OpenAIMessage): string {
  return message.tool_calls![0]!.function.arguments;
}

describe('pressure relief for oversized arguments', () => {
  it('allows synthesis after a multi-hundred-KB argument payload, preserving JSON and pairing', () => {
    const original = JSON.stringify({ content: '😀'.repeat(150_000) });
    const turns: OpenAIMessage[] = [call(original), { role: 'tool', tool_call_id: 'write', content: 'written' }];
    const ctx = context(turns);
    expect(canSynthesizeUnderPressure(ctx, 0)).toBe(false);
    expect(windDownForContextPressure(ctx, 0)).toBe(true);
    expect(canSynthesizeUnderPressure(ctx, 0)).toBe(true);
    const shrunk = args(ctx.priorTurns[0]!);
    const parsed = JSON.parse(shrunk) as { _truncated: string; preview: string };
    expect(parsed._truncated).toContain(`${Buffer.byteLength(original)} UTF-8 bytes`);
    expect(parsed._truncated).toContain('Context pressure');
    expect(parsed.preview).toContain('😀');
    expect(parsed.preview.isWellFormed()).toBe(true);
    expect(ctx.priorTurns[0]!.tool_calls![0]).toMatchObject({ id: 'write', function: { name: 'write_file' } });
    expect(ctx.priorTurns[1]!.tool_call_id).toBe('write');
  });

  it('leaves normal turns byte-for-byte unchanged', () => {
    const turns = [call(JSON.stringify({ content: 'x'.repeat(20_000) }))];
    const before = JSON.stringify(turns);
    expect(windDownForContextPressure(context(turns), 0)).toBe(false);
    expect(JSON.stringify(turns)).toBe(before);
  });

  it('leaves arguments byte-for-byte unchanged when result bounding alone relieves pressure', () => {
    const assistant = call(JSON.stringify({ content: 'x'.repeat(20_000) }));
    const turns: OpenAIMessage[] = [assistant, { role: 'tool', tool_call_id: 'write', content: 'x'.repeat(500_000) }];
    const before = JSON.stringify(assistant);
    const ctx = context(turns);
    expect(windDownForContextPressure(ctx, 0)).toBe(true);
    expect(canSynthesizeUnderPressure(ctx, 0)).toBe(true);
    expect(JSON.stringify(turns[0])).toBe(before);
    expect(turns[0]).toBe(assistant);
  });

  it('only shrinks appended oversized calls, leaving small siblings and source objects intact', () => {
    const old = call(JSON.stringify({ content: 'old'.repeat(200_000) }), 'old');
    const large = call(JSON.stringify({ content: 'x'.repeat(600_000) }));
    const small = call('{ "path": "a" }', 'small');
    const before = JSON.stringify([old, large, small]);
    const turns = [old, large, small];
    const ctx = context(turns);
    windDownForContextPressure(ctx, 1);
    expect(canSynthesizeUnderPressure(ctx, 1)).toBe(true);
    expect(turns[0]).toBe(old);
    expect(turns[2]).toBe(small);
    expect(JSON.stringify([old, large, small])).toBe(before);
  });
});
