/** Real web owner, wiring, session and providers; only SDK/infra boundaries faked. */
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fallback = vi.hoisted(() => ({ model: undefined as string | undefined }));
vi.mock('../cli/config/json-tier.js', async (original) => ({
  ...(await original<Record<string, unknown>>()),
  loadJsonConfig: () => ({ config: fallback.model ? { fallbackModel: fallback.model } : {}, modelsPartial: {}, sourcePath: undefined }),
}));
vi.mock('./session-owner.mcp-warm.js', () => ({ takeWebMcpManager: async () => undefined }));
vi.mock('../agent/default-hook-registry.js', () => ({ createDefaultHookRegistry: () => ({ registry: undefined }) }));
vi.mock('../agent/session/wire-executors.js', () => ({
  wireExecutors: () => ({
    rootManager: { setOnSubagentSucceeded: () => {}, abortAllAndDrain: async () => {}, getPendingChildTerminalWrites: () => [] },
    composeExecutor: { setOnSubagentSucceeded: () => {} },
  }),
}));
vi.mock('../utils/debug.js', () => ({ debugLog: vi.fn() }));

import { SessionOwner } from './session-owner.js';
import { useTmpAfkHome } from '../agent/journal/__test-utils__/helpers.js';
import { resetSlotBindings } from '../agent/session/model-slots.js';
import { getSessionLedgerPath } from '../paths.js';
import { ledgerRecordToItem } from './shared/ledger-adapter.js';
import {
  installWire, uninstallWire, usageLimit429, modelNotFound404, anthropicText, openaiText,
} from '../agent/session/__test-utils__/model-fallback-wire.js';

useTmpAfkHome();
const PRIMARY = 'claude-sonnet-4-6';
const SAME_FAMILY = 'claude-haiku-5-5';
const OPENAI = 'gpt-4o';

beforeEach(() => {
  resetSlotBindings();
  vi.stubEnv('AFK_TRACE_DISABLED', '1');
  vi.stubEnv('OPENAI_API_KEY', 'sk-openai-test');
  vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
  fallback.model = SAME_FAMILY;
});
afterEach(() => { uninstallWire(); resetSlotBindings(); vi.unstubAllEnvs(); });

async function turn(owner: SessionOwner, id: string) {
  owner.submitPrompt(id, 'hello');
  // Acceptance is synchronous; wait on the owner's actual serialized turn.
  await (owner as unknown as { turns: Map<string, Promise<void>> }).turns.get(id);
  // The ledger is intentionally fire-and-forget; wait for its disk projection.
  await vi.waitFor(() => expect(records(id).some(record => record['kind'] === 'done' || record['kind'] === 'error')).toBe(true));
}
function records(id: string): Array<Record<string, unknown>> {
  return readFileSync(getSessionLedgerPath(id), 'utf8').trim().split('\n').map(line => JSON.parse(line));
}

describe('web configured model fallback', () => {
  it.each([SAME_FAMILY, OPENAI])('switches to %s on usage limit and persists one visible notice across turns', async (target) => {
    fallback.model = target;
    const wire = installWire(model => model === PRIMARY ? usageLimit429() : {
      events: target === OPENAI ? openaiText('Fallback answer') : anthropicText(model, 'Fallback answer'),
    });
    const owner = new SessionOwner({ model: PRIMARY });
    try {
      const { id } = await owner.create();
      await turn(owner, id);
      expect(wire.bodies.map(body => body.model)).toEqual([PRIMARY, target]);
      const notices = records(id).filter(record => record['kind'] === 'model_fallback');
      expect(notices).toHaveLength(1);
      expect(ledgerRecordToItem(notices[0]!)).toMatchObject({
        kind: 'notice', noticeKind: 'model-fallback', text: expect.stringContaining(`Continuing on ${target}.`),
      });
      expect(JSON.stringify(records(id))).toContain('Fallback answer');
      await turn(owner, id);
      expect(wire.bodies.at(-1)?.model).toBe(target);
      expect(records(id).filter(record => record['kind'] === 'model_fallback')).toHaveLength(1);
    } finally { await owner.closeAll(); }
  });

  it('keeps the primary direct path and emits no notice without configured fallback', async () => {
    fallback.model = undefined;
    const wire = installWire(model => ({ events: anthropicText(model, 'Primary answer') }));
    const owner = new SessionOwner({ model: PRIMARY });
    try {
      const { id } = await owner.create();
      await turn(owner, id);
      expect(wire.bodies.map(body => body.model)).toEqual([PRIMARY]);
      expect(JSON.stringify(records(id))).toContain('Primary answer');
      expect(records(id).some(record => record['kind'] === 'model_fallback')).toBe(false);
    } finally { await owner.closeAll(); }
  });

  it('does not switch on primary failure without configured fallback', async () => {
    fallback.model = undefined;
    const wire = installWire(model => modelNotFound404(model));
    const owner = new SessionOwner({ model: PRIMARY });
    try {
      const { id } = await owner.create();
      await turn(owner, id);
      expect(wire.bodies.every(body => body.model === PRIMARY)).toBe(true);
      expect(records(id).some(record => record['kind'] === 'error')).toBe(true);
      expect(records(id).some(record => record['kind'] === 'model_fallback')).toBe(false);
    } finally { await owner.closeAll(); }
  });
});
