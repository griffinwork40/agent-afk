/** Regression coverage for the production dispatcher-cwd accessor (#3767). */
import type Anthropic from '@anthropic-ai/sdk';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentConfig } from '../../types/config-types.js';
import type { ProviderQueryContext } from './provider-context.js';
import { AnthropicDirectProvider } from './index.js';
import { setUpQuerySession } from './provider-query-setup.js';

const providers: AnthropicDirectProvider[] = [];

afterEach(() => {
  for (const provider of providers.splice(0)) provider.close();
  vi.restoreAllMocks();
});

function setup(cwd?: string, readRoots?: string[]) {
  const provider = new AnthropicDirectProvider({
    // Setup never calls the API; retain real dispatcher, roots and prompt wiring.
    clientFactory: () => ({} as Anthropic),
  });
  providers.push(provider);
  // Use the provider-owned live state rather than stubbing getDispatcherCwd.
  const ctx = (provider as unknown as { queryContext(): ProviderQueryContext }).queryContext();
  const build = vi.spyOn(ctx, 'buildDispatcher');
  const config = {
    model: 'claude-sonnet-4-5',
    apiKey: 'sk-ant-test-cwd',
    depth: 1,
    parentSessionId: 'unconfined-parent',
    ...(cwd === undefined ? {} : { cwd }),
    ...(readRoots === undefined ? {} : { readRoots }),
  } as AgentConfig;
  const session = setUpQuerySession(
    ctx,
    { prompt: (async function* () { yield { content: 'inspect cwd' }; })(), config },
    'anthropic-direct',
    'claude-sonnet-4-5',
  );
  return { ctx, build, session };
}

describe('setUpQuerySession dispatcher cwd', () => {
  it('keeps an unconfined child unconfined on initial build and model-switch rebuild', () => {
    const { ctx, build, session } = setup();
    expect(ctx.getCurrentCwd()).toBeUndefined();
    expect(ctx.getSharedReadRoots()).toEqual([]);
    // Display cwd still has its fallback; it must not become containment cwd.
    expect(session.cwd).toBe(process.cwd());
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0]?.[1]?.cwd).toBeUndefined();

    session.modelToolsFactory('claude-opus-4-5', 'default');
    expect(build).toHaveBeenCalledTimes(2);
    expect(build.mock.calls[1]?.[1]?.cwd).toBeUndefined();
  });

  it('passes config.cwd through on initial build and model-switch rebuild', () => {
    const cwd = fileURLToPath(new URL('.', import.meta.url));
    const { build, session } = setup(cwd);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0]?.[1]?.cwd).toBe(cwd);

    session.modelToolsFactory('claude-opus-4-5', 'default');
    expect(build).toHaveBeenCalledTimes(2);
    expect(build.mock.calls[1]?.[1]?.cwd).toBe(cwd);
  });

  it('re-reads the live cwd when rebuilding instead of capturing config.cwd', () => {
    // Use a dir that differs from process.cwd() so the assertion is discriminating
    // on its own — if the accessor captured config.cwd (undefined) and fell back
    // to process.cwd() the test would still pass, masking the regression.
    const liveCwd = fileURLToPath(new URL('.', import.meta.url));
    // Guard: liveCwd must differ from process.cwd(); otherwise the
    // discriminating check below cannot distinguish the two code paths.
    expect(liveCwd).not.toBe(process.cwd());
    const { ctx, build, session } = setup();
    ctx.setCurrentCwd(liveCwd);
    session.modelToolsFactory('claude-opus-4-5', 'default');
    expect(build).toHaveBeenCalledTimes(2);
    expect(build.mock.calls[1]?.[1]?.cwd).toBe(liveCwd);
  });

  it('inherits readRoots from config into sharedReadRoots for a confined fork', () => {
    // Exercises the fork-inheritance path: when config.readRoots is supplied
    // (as a forked subagent would do), setUpQuerySession must propagate them
    // into the provider's sharedReadRoots so the dispatcher is built with the
    // correct read scope (#3775).
    const extraRoot = fileURLToPath(new URL('.', import.meta.url));
    const { ctx } = setup(extraRoot, [extraRoot]);
    const roots = ctx.getSharedReadRoots();
    expect(roots).toBeDefined();
    expect(roots).toContain(extraRoot);
  });

  it('lets an unconfined child read an absolute path through the real dispatcher', async () => {
    const { session } = setup();
    const filePath = fileURLToPath(import.meta.url);
    for (const dispatcher of [
      session.queryDispatcher,
      session.modelToolsFactory('claude-opus-4-5', 'default').dispatcher,
    ]) {
      const result = await dispatcher.execute({
        id: 'read-unconfined-cwd-fixture',
        name: 'read_file',
        input: { file_path: filePath },
        signal: new AbortController().signal,
      });
      expect(result.isError).not.toBe(true);
      expect(result.content).toContain('Regression coverage for the production dispatcher-cwd accessor');
    }
  });
});
