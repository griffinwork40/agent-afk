/**
 * Unit tests for dispatchTurnStop: the session-layer Stop dispatch that runs
 * at the end of every top-level turn on every surface.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHookRegistry } from '../hooks.js';
import type { AgentConfig, Message } from '../types.js';
import type { StopWiring } from '../types/session-types.js';
import type { ToolEventMin } from '../done-evidence.js';
import { dispatchTurnStop, type TurnStopParams } from './turn-stream-runner.stop.js';

vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));

const DONE_TEXT = 'All set.\n\n**Done**\n- What was done: changed the parser';
const history = (text: string): Message[] => [
  { role: 'user', content: 'do the thing' },
  { role: 'assistant', content: text },
];

function setup(overrides: Partial<TurnStopParams> = {}, handlerResult: object = {}) {
  const registry = createHookRegistry();
  const seen: Record<string, unknown>[] = [];
  registry.register('Stop', async (ctx) => {
    seen.push(ctx as unknown as Record<string, unknown>);
    return handlerResult;
  });
  const wiring: StopWiring = {
    getHasNextTurn: () => true,
    onStopInjectContext: vi.fn(),
    onStopBlocked: vi.fn(),
    onStopTimeout: vi.fn(),
  };
  const params: TurnStopParams = {
    config: { hookRegistry: registry } as unknown as AgentConfig,
    wiring,
    sessionId: 'sess-1',
    signal: new AbortController().signal,
    conversationHistory: history(DONE_TEXT),
    toolEvents: [],
    ...overrides,
  };
  return { params, seen, wiring };
}

const edit: ToolEventMin = { toolName: 'edit_file', input: 'src/parser.ts', isError: false };
const bash = (input: string, isError = false): ToolEventMin => ({ toolName: 'bash', input, isError });

describe('dispatchTurnStop', () => {
  it('does nothing when the surface has not wired Stop', async () => {
    const { params, seen } = setup({ wiring: undefined });
    await dispatchTurnStop(params);
    expect(seen).toHaveLength(0);
  });

  it('does nothing inside a forked subagent (parentSessionId set)', async () => {
    const { params, seen } = setup();
    params.config = { ...params.config, parentSessionId: 'parent' } as AgentConfig;
    await dispatchTurnStop(params);
    expect(seen).toHaveLength(0);
  });

  it('classifies edit followed by a passing `pnpm test` as verified (real bash input)', async () => {
    const { params, seen } = setup({ toolEvents: [edit, bash('pnpm test')] });
    await dispatchTurnStop(params);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      event: 'Stop',
      sessionId: 'sess-1',
      terminalState: 'done',
      doneEvidenceClassification: 'verified',
      doneHasCorroboratingEvidence: true,
    });
  });

  it('classifies an edit with no verification as unverified', async () => {
    const { params, seen } = setup({ toolEvents: [edit] });
    await dispatchTurnStop(params);
    expect(seen[0]).toMatchObject({ doneEvidenceClassification: 'unverified' });
  });

  it('does not count a failed test command as verification', async () => {
    const { params, seen } = setup({ toolEvents: [edit, bash('pnpm test', true)] });
    await dispatchTurnStop(params);
    expect(seen[0]).toMatchObject({ doneEvidenceClassification: 'unverified' });
  });

  it('classifies a turn with no code mutation as no-code-changes', async () => {
    const { params, seen } = setup({ toolEvents: [bash('ls')] });
    await dispatchTurnStop(params);
    expect(seen[0]).toMatchObject({ doneEvidenceClassification: 'no-code-changes' });
  });

  it('omits the Done-evidence fields when the turn did not end in Done', async () => {
    const { params, seen } = setup({ conversationHistory: history('just chatting') });
    await dispatchTurnStop(params);
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toHaveProperty('doneEvidenceClassification');
    expect(seen[0]).not.toHaveProperty('terminalState');
  });

  it('routes injectContext to the wiring when the surface has a next turn', async () => {
    const { params, wiring } = setup({}, { injectContext: 'please verify' });
    await dispatchTurnStop(params);
    expect(wiring.onStopInjectContext).toHaveBeenCalledWith('please verify');
  });

  it('drops injectContext on a one-shot surface (no next turn)', async () => {
    const { params, wiring } = setup({}, { injectContext: 'please verify' });
    const oneShot: StopWiring = { ...wiring, getHasNextTurn: () => false };
    await dispatchTurnStop({ ...params, wiring: oneShot });
    expect(wiring.onStopInjectContext).not.toHaveBeenCalled();
  });

  it('reports a block with its reason and does not throw', async () => {
    const { params, wiring } = setup({}, { decision: 'block', reason: 'no evidence' });
    await expect(dispatchTurnStop(params)).resolves.toBeUndefined();
    expect(wiring.onStopBlocked).toHaveBeenCalledWith('no evidence');
    expect(wiring.onStopInjectContext).not.toHaveBeenCalled();
  });
});
