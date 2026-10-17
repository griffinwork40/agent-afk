/**
 * Live API smoke test for the `anthropic-direct` provider.
 *
 * Skipped unless `RUN_LIVE_API=1` is set. Verifies that an OAuth token from
 * `CLAUDE_CODE_OAUTH_TOKEN` round-trips through the full provider stack to a
 * real assistant response.
 */

import { describe, it, expect } from 'vitest';
import { AnthropicDirectProvider } from './anthropic-direct/index.js';
import type { ProviderEvent } from '../provider.js';

const SHOULD_RUN = process.env['RUN_LIVE_API'] === '1';

// Capture at module scope — vitest's global beforeEach (clean-config-env.ts)
// deletes every ENV_REGISTRY key from process.env before each test body runs,
// so a test-time read of process.env['CLAUDE_CODE_OAUTH_TOKEN'] always yields
// undefined. Module-scope runs before setupFiles' beforeEach hooks.
const OAUTH_TOKEN = process.env['CLAUDE_CODE_OAUTH_TOKEN'];

describe.skipIf(!SHOULD_RUN)('AnthropicDirectProvider — live API', () => {
  it('round-trips a real call using CLAUDE_CODE_OAUTH_TOKEN', async () => {
    const token = OAUTH_TOKEN;
    if (!token) throw new Error('CLAUDE_CODE_OAUTH_TOKEN not set');
    const provider = new AnthropicDirectProvider();
    async function* once(): AsyncIterable<{ content: string }> {
      yield { content: 'Reply with exactly the word PONG and nothing else.' };
    }
    const query = provider.query({
      prompt: once(),
      config: {
        apiKey: token,
        model: 'claude-sonnet-5',
        maxOutputTokens: 20,
      },
    });
    const events: ProviderEvent[] = [];
    for await (const ev of query) {
      events.push(ev);
      if (ev.type === 'turn.completed') break;
    }
    query.close();
    const assistant = events.find((e) => e.type === 'assistant.message');
    expect(assistant).toBeDefined();
    if (assistant?.type === 'assistant.message') {
      expect(assistant.text.length).toBeGreaterThan(0);
    }
  }, 30000);
});
