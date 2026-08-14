/**
 * complete() must ignore OpenAI shim baseUrl (suggest engine path).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenAICompatibleProvider } from '../openai-compatible/index.js';
import { DEFAULT_XAI_API_BASE_URL } from './endpoints.js';
import { XaiProvider } from './index.js';

describe('XaiProvider.complete — endpoint isolation', () => {
  let completeSpy: ReturnType<typeof vi.spyOn>;
  let setDefaultsSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    completeSpy = vi
      .spyOn(OpenAICompatibleProvider.prototype, 'complete')
      .mockResolvedValue('ok');
    setDefaultsSpy = vi
      .spyOn(OpenAICompatibleProvider.prototype, 'setEndpointDefaults')
      .mockImplementation(() => undefined);
  });

  afterEach(() => {
    completeSpy.mockRestore();
    setDefaultsSpy.mockRestore();
  });

  it('uses resolved xAI endpoint even when args.baseUrl is an OpenAI shim URL', async () => {
    const provider = new XaiProvider({
      authMode: 'apikey',
      authDeps: {
        readEnv: (k) => (k === 'XAI_API_KEY' ? 'xai-test-key' : undefined),
        store: { readFile: () => null },
      },
    });

    await provider.complete({
      system: 's',
      user: 'u',
      apiKey: 'xai-test-key',
      baseUrl: 'http://localhost:11434/v1',
    });

    expect(completeSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'xai-test-key',
        baseUrl: DEFAULT_XAI_API_BASE_URL,
      }),
    );
    expect(setDefaultsSpy).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: DEFAULT_XAI_API_BASE_URL }),
    );
  });
});
