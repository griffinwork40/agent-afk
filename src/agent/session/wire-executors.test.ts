/**
 * wireExecutors → root `agent` executor `defaultConfig` threading (#3324).
 *
 * Unnamed `agent` children receive the lean worker prompt instead of the
 * composed parent base, so the bare operator overlay must reach the executor
 * as its own field or AFK.md instructions silently vanish from children.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { wireExecutors, type WireExecutorsOptions } from './wire-executors.js';
import type { SubagentExecutorContext } from '../tools/subagent-executor.js';

let tmpHome: string;
let prevHome: string | undefined;

beforeAll(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'afk-wire-executors-'));
  prevHome = process.env['AFK_HOME'];
  process.env['AFK_HOME'] = tmpHome;
});

afterAll(() => {
  if (prevHome === undefined) delete process.env['AFK_HOME'];
  else process.env['AFK_HOME'] = prevHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

function wire(extra: Partial<WireExecutorsOptions>): SubagentExecutorContext['defaultConfig'] {
  const signal = new AbortController().signal;
  const { subagentExecutor } = wireExecutors({
    surface: 'cli',
    parentSession: {
      sessionId: undefined,
      getInputStreamRef: () => ({ pushUserMessage: () => {} }),
      abortSignal: signal,
    } as unknown as SubagentExecutorContext['parentSession'],
    apiKey: 'k',
    model: 'sonnet',
    managerParentModel: 'sonnet',
    defaultSubagentModel: 'sonnet',
    resolveApiKeyForModel: () => 'k',
    cwd: tmpHome,
    agentRegistryWarn: () => {},
    ...extra,
  });
  return (subagentExecutor as unknown as { ctx: SubagentExecutorContext }).ctx.defaultConfig;
}

describe('wireExecutors: operator overlay reaches the agent executor (#3324)', () => {
  it('forwards operatorOverlay alongside the composed systemPrompt', () => {
    const dc = wire({ systemPrompt: 'FRAMEWORK + OVERLAY', operatorOverlay: 'OVERLAY' });
    expect(dc.operatorOverlay).toBe('OVERLAY');
    expect(dc.systemPrompt).toBe('FRAMEWORK + OVERLAY');
  });

  it('leaves operatorOverlay absent (not undefined-valued) when none is configured', () => {
    const dc = wire({ systemPrompt: 'FRAMEWORK' });
    expect(dc).not.toHaveProperty('operatorOverlay');
  });
});
