/**
 * Production wiring for the background process registry: the REPL bootstrap
 * deps carry it, both providers' per-query dispatchers receive the SAME
 * instance, and the dispatcher hands it to `bash` only. Mirrors
 * detach-registry-wiring.test.ts.
 */

import { describe, expect, it } from 'vitest';
import * as os from 'node:os';
import { ProcessJobRegistry } from './process-jobs.js';
import { AnthropicDirectProvider } from '../providers/anthropic-direct/index.js';
import { OpenAICompatibleProvider } from '../providers/openai-compatible/index.js';
import type { SessionToolDispatcher } from '../tools/dispatcher.js';
import { buildSharedDeps } from '../../cli/commands/interactive/bootstrap-session-builder.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

function registry(): ProcessJobRegistry {
  return new ProcessJobRegistry({ logDir: os.tmpdir(), sweep: false });
}

function dispatcherJobs(d: SessionToolDispatcher): ProcessJobRegistry | undefined {
  return (d as any).processJobs as ProcessJobRegistry | undefined;
}

function contextFor(d: SessionToolDispatcher, name: string): Record<string, unknown> {
  return (d as any).callHandlerContext({ id: 'x', name, input: {}, signal: new AbortController().signal });
}

describe('ProcessJobRegistry production wiring', () => {
  it('AnthropicDirectProvider.buildDispatcher threads the same instance', () => {
    const reg = registry();
    const d = (new AnthropicDirectProvider() as any).buildDispatcher('default', { processJobs: reg }) as SessionToolDispatcher;
    expect(dispatcherJobs(d)).toBe(reg);
  });

  it('OpenAICompatibleProvider.buildDispatcher threads the same instance', () => {
    const reg = registry();
    const d = (new OpenAICompatibleProvider() as any).buildDispatcher('default', { processJobs: reg }) as SessionToolDispatcher;
    expect(dispatcherJobs(d)).toBe(reg);
  });

  it('is absent when not supplied (fork / headless path)', () => {
    const d = (new AnthropicDirectProvider() as any).buildDispatcher('default', {}) as SessionToolDispatcher;
    expect(dispatcherJobs(d)).toBeUndefined();
  });

  it('is handed to bash only, never to other tools', () => {
    const reg = registry();
    const d = (new AnthropicDirectProvider() as any).buildDispatcher('default', { processJobs: reg }) as SessionToolDispatcher;
    expect(contextFor(d, 'bash')['processJobs']).toBe(reg);
    expect(contextFor(d, 'read_file')['processJobs']).toBeUndefined();
  });

  it('buildSharedDeps carries the registry into the session deps', () => {
    const reg = registry();
    const deps = buildSharedDeps({
      sessionModel: 'claude-sonnet-4-5',
      resumeConfig: {},
      systemPrompt: undefined,
      systemPromptSource: undefined,
      thinking: undefined,
      effort: undefined,
      maxOutputTokens: undefined,
      maxToolUseIterations: undefined,
      cliConfig: { baseUrl: undefined } as any,
      providerFactory: (() => {}) as any,
      hookRegistry: { register: () => {} } as any,
      traceWriter: undefined,
      processJobs: reg,
      effectiveCwd: undefined,
      maxTurns: '0',
      initialPermissionMode: undefined,
    });
    expect(deps.processJobs).toBe(reg);
  });
});
