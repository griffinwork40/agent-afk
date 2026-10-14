import { describe, expect, it, vi } from 'vitest';
import type { TelegramSessionBuildContext } from './session-context.js';
import type { StateStore } from '../agent/state/state-store.js';

const mocks = vi.hoisted(() => ({ anthropic: vi.fn(), openai: vi.fn(), xai: vi.fn() }));
vi.mock('../agent/providers/index.js', () => ({
  AnthropicDirectProvider: class { constructor(opts: unknown) { mocks.anthropic(opts); } },
  OpenAICompatibleProvider: class { constructor(opts: unknown) { mocks.openai(opts); } },
}));
vi.mock('../agent/providers/xai/index.js', () => ({
  XaiProvider: class { constructor(opts: unknown) { mocks.xai(opts); } },
}));
vi.mock('./session-builder.js', () => ({
  buildTelegramSession: async (opts: { providerFactory: (args: unknown) => unknown }) =>
    opts.providerFactory({ executors: {} }),
}));
import { buildAnthropicTelegramSession } from './session-anthropic.js';
import { buildOpenAiTelegramSession } from './session-openai.js';
import { buildXaiTelegramSession } from './session-xai.js';

const stateStore = { close: vi.fn() } as unknown as StateStore;
const ctx = { config: {}, sessionConfig: { model: 'sonnet' }, stateStore } as TelegramSessionBuildContext;
describe('Telegram shared state provider wiring', () => {
  it('injects shared state into all three provider branches without taking ownership', async () => {
    await buildAnthropicTelegramSession(ctx);
    await buildOpenAiTelegramSession(ctx);
    await buildXaiTelegramSession({ ...ctx, providerName: 'xai' });
    for (const ctor of [mocks.anthropic, mocks.openai, mocks.xai]) {
      expect(ctor).toHaveBeenCalledWith(expect.objectContaining({ stateStore }));
    }
    expect(stateStore.close).not.toHaveBeenCalled();
  });
});
