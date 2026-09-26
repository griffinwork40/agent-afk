/**
 * `/fast` wiring: parseProvider must hand the REPL's FastModeController to the
 * OpenAI provider as well as Anthropic, or `/fast on` silently does nothing on
 * gpt-* / ChatGPT-subscription sessions (the pre-fix behaviour).
 */

import { describe, it, expect } from 'vitest';
import { parseProvider } from './shared-helpers.js';
import { FastModeController } from '../agent/fast-mode.js';
import { OpenAICompatibleProvider } from '../agent/providers/openai-compatible/index.js';

function readController(p: unknown): FastModeController | undefined {
  return (p as { providerOpts?: { fastModeController?: FastModeController } }).providerOpts?.fastModeController;
}

describe('parseProvider — fast mode controller', () => {
  it.each(['openai', 'openai-compatible'])('threads the controller into %s', (name) => {
    const controller = new FastModeController('on');
    const provider = parseProvider(name, { fastModeController: controller });
    expect(provider).toBeInstanceOf(OpenAICompatibleProvider);
    expect(readController(provider)).toBe(controller);
  });

  it('leaves the OpenAI provider without a controller when none is supplied', () => {
    expect(readController(parseProvider('openai', {}))).toBeUndefined();
  });
});
