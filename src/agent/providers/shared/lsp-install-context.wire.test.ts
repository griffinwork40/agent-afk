import { afterEach, describe, expect, it, vi } from 'vitest';
import { AnthropicDirectProvider, OpenAICompatibleProvider } from '../index.js';
import type { AgentConfig } from '../../types/config-types.js';
import type { ModelProvider, ProviderUserTurn } from '../../provider.js';
import type { SessionToolDispatcher } from '../../tools/dispatcher.js';
import { elicitationRouter } from '../../elicitation-router.js';
import { lspInstallContext } from '../../tools/handlers/lsp-install-consent.js';
import type { ToolHandlerContext } from '../../tools/types.js';

const providers: ModelProvider[] = [];
afterEach(() => { for (const p of providers.splice(0)) p.close?.(); vi.restoreAllMocks(); });
async function* empty(): AsyncIterable<ProviderUserTurn> {}

for (const [name, make, model] of [
  ['anthropic', () => new AnthropicDirectProvider({}), 'claude-sonnet-5'],
  ['openai', () => new OpenAICompatibleProvider({}), 'gpt-5.1'],
] as const) {
  describe(`${name}: real query -> dispatcher -> handler install eligibility`, () => {
    it.each([
      [{ surface: 'cli', lspInstallAllowed: true }, true],
      [{ surface: 'telegram', lspInstallAllowed: true }, true],
      [{ surface: 'cli' }, false], // one-shot / unspecified cli is not opted in
      [{ surface: 'cli', lspInstallAllowed: true, isNonInteractive: true }, false],
      [{ surface: 'daemon', lspInstallAllowed: true }, false],
      [{ surface: 'cron', lspInstallAllowed: true }, false],
      [{ surface: 'telegram', lspInstallAllowed: true, depth: 1 }, false],
      [{ surface: 'cli', lspInstallAllowed: true, parentSessionId: 'root' }, false],
      [{ surface: 'telegram', lspInstallAllowed: true, subagentId: 'child' }, false],
    ] as const)('filters %j to %s', async (config, allowed) => {
      const p = make(); providers.push(p);
      const target = p as unknown as { buildDispatcher(mode: string, opts: object): SessionToolDispatcher };
      const original = target.buildDispatcher.bind(p);
      let dispatcher: SessionToolDispatcher | undefined;
      let context: ToolHandlerContext | undefined;
      vi.spyOn(target, 'buildDispatcher').mockImplementation((mode, opts) => {
        dispatcher = original(mode, opts);
        // Install a recorder on the real instance, preserving all production context wiring.
        (dispatcher as unknown as { handlers: Map<string, unknown> }).handlers.set('probe_lsp',
          async (_input: unknown, _signal: AbortSignal, ctx: ToolHandlerContext) => { context = ctx; return { content: 'ok' }; });
        return dispatcher;
      });
      let query;
      try { query = p.query({ prompt: empty(), config: { model, apiKey: 'test-key', ...config } as AgentConfig }); }
      catch { /* Some providers validate credentials after constructing tools. */ }
      expect(dispatcher).toBeDefined();
      await dispatcher!.execute({ name: 'probe_lsp', id: 'probe', input: { lspInstallAllowed: true }, signal: new AbortController().signal });
      expect(context?.lspInstallAllowed).toBe(allowed);
      vi.spyOn(elicitationRouter, 'hasHandler').mockReturnValue(false);
      expect(lspInstallContext(context).interactive).toBe(false);
      vi.mocked(elicitationRouter.hasHandler).mockReturnValue(true);
      expect(lspInstallContext(context).interactive).toBe(allowed);
      if (query) await query.close();
    });
  });
}
