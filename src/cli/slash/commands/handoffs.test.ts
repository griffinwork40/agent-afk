/**
 * Tests for the /handoffs and /handoffs:answer slash commands.
 *
 * Covers:
 *  - /handoffs with no pending records → info message
 *  - /handoffs with pending records → table output
 *  - /handoffs:answer with no id → usage warning
 *  - /handoffs:answer with unknown id → error
 *  - /handoffs:answer with no inline answer → warn + usage hint
 *  - /handoffs:answer inline text answer → success
 *  - /handoffs:answer inline confirm (yes/no) → success
 *  - /handoffs:answer inline number → success
 *  - /handoffs:answer inline choice by index → success
 *  - /handoffs:answer already-answered → warn (won: false)
 *  - /handoffs:answer store error → error
 *  - listPendingHandoffs failure → error in /handoffs
 *  - prefix-match resolution
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks — must be hoisted before the subject imports
// ---------------------------------------------------------------------------

vi.mock('../../../agent/daemon/handoff-store.js', () => ({
  listPendingHandoffs: vi.fn(),
}));

vi.mock('../../../agent/daemon/handoff-wiring.js', () => ({
  answerHandoff: vi.fn(),
}));

import { listPendingHandoffs } from '../../../agent/daemon/handoff-store.js';
import { answerHandoff } from '../../../agent/daemon/handoff-wiring.js';
import { handoffsCmd, handoffsAnswerCmd } from './handoffs.js';
import type { HandoffRecord } from '../../../agent/daemon/handoff-store.js';

const mockList = vi.mocked(listPendingHandoffs);
const mockAnswer = vi.mocked(answerHandoff);

// ---------------------------------------------------------------------------
// Test context builder
// ---------------------------------------------------------------------------

interface CapturedOutput {
  lines: string[];
  infos: string[];
  warns: string[];
  errors: string[];
  successes: string[];
}

function makeCtx(): { ctx: Parameters<typeof handoffsCmd['handler']>[0]; output: CapturedOutput } {
  const output: CapturedOutput = {
    lines: [],
    infos: [],
    warns: [],
    errors: [],
    successes: [],
  };
  const ctx = {
    out: {
      line: (t?: string) => { output.lines.push(t ?? ''); },
      info: (t: string) => { output.infos.push(t); },
      warn: (t: string) => { output.warns.push(t); },
      error: (t: string) => { output.errors.push(t); },
      success: (t: string) => { output.successes.push(t); },
      raw: (t: string) => { output.lines.push(t); },
    },
    stats: {} as Parameters<typeof handoffsCmd['handler']>[0]['stats'],
    session: {} as Parameters<typeof handoffsCmd['handler']>[0]['session'],
    ui: {} as Parameters<typeof handoffsCmd['handler']>[0]['ui'],
    ledger: undefined,
  } as unknown as Parameters<typeof handoffsCmd['handler']>[0];
  return { ctx, output };
}

function makePendingRecord(overrides: Partial<HandoffRecord> = {}): HandoffRecord {
  return {
    taskId: 'q-1234567890-abcdef',
    sessionId: 'sess-abc',
    question: { type: 'text', message: 'What is your name?' },
    requestType: 'ask_question',
    createdAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago
    status: 'pending',
    originalCommand: 'echo test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// /handoffs
// ---------------------------------------------------------------------------

describe('/handoffs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows info when no pending handoffs', async () => {
    mockList.mockResolvedValue([]);
    const { ctx, output } = makeCtx();
    const result = await handoffsCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(output.infos).toContain('No pending daemon handoffs.');
  });

  it('lists pending handoffs in a table', async () => {
    const record = makePendingRecord();
    mockList.mockResolvedValue([record]);
    const { ctx, output } = makeCtx();
    const result = await handoffsCmd.handler(ctx, '');
    expect(result).toBe('continue');
    const allText = output.lines.join('\n');
    expect(allText).toContain('q-1234567890-abc'); // shortId prefix visible in output
    expect(allText).toContain('What is your name?');
    expect(allText).toContain('/handoffs:answer');
  });

  it('shows plural heading for multiple records', async () => {
    mockList.mockResolvedValue([
      makePendingRecord({ taskId: 'q-111' }),
      makePendingRecord({ taskId: 'q-222' }),
    ]);
    const { ctx, output } = makeCtx();
    await handoffsCmd.handler(ctx, '');
    const allText = output.lines.join('\n');
    expect(allText).toContain('2 pending handoffs');
  });

  it('emits error when listPendingHandoffs throws', async () => {
    mockList.mockRejectedValue(new Error('disk error'));
    const { ctx, output } = makeCtx();
    const result = await handoffsCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(output.errors[0]).toMatch(/disk error/);
  });
});

// ---------------------------------------------------------------------------
// /handoffs:answer
// ---------------------------------------------------------------------------

describe('/handoffs:answer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows usage warning when no id given', async () => {
    const { ctx, output } = makeCtx();
    const result = await handoffsAnswerCmd.handler(ctx, '');
    expect(result).toBe('continue');
    expect(output.warns[0]).toMatch(/Usage/);
  });

  it('errors when no pending records match', async () => {
    mockList.mockResolvedValue([]);
    const { ctx, output } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'no-such-task');
    expect(output.errors[0]).toMatch(/No pending handoffs/);
  });

  it('errors when id does not match any record', async () => {
    mockList.mockResolvedValue([makePendingRecord()]);
    const { ctx, output } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'zzz-unknown answer');
    expect(output.errors[0]).toMatch(/No pending handoff matches/);
  });

  it('warns when no inline answer provided', async () => {
    mockList.mockResolvedValue([makePendingRecord()]);
    const { ctx, output } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'q-1234567890-abcdef');
    expect(output.warns[0]).toMatch(/Provide your answer inline/);
  });

  it('records a text answer successfully', async () => {
    mockList.mockResolvedValue([makePendingRecord()]);
    mockAnswer.mockResolvedValue(true);
    const { ctx, output } = makeCtx();
    const result = await handoffsAnswerCmd.handler(ctx, 'q-1234567890-abcdef Alice');
    expect(result).toBe('continue');
    expect(mockAnswer).toHaveBeenCalledWith(
      'q-1234567890-abcdef',
      { value: 'Alice' },
      'repl',
      undefined,
      'repl',
    );
    expect(output.successes[0]).toMatch(/Answer recorded/);
  });

  it('resolves by prefix match', async () => {
    mockList.mockResolvedValue([makePendingRecord()]);
    mockAnswer.mockResolvedValue(true);
    const { ctx, output } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'q-123 Alice');
    expect(mockAnswer).toHaveBeenCalledWith(
      'q-1234567890-abcdef',
      { value: 'Alice' },
      'repl',
      undefined,
      'repl',
    );
    expect(output.successes[0]).toMatch(/Answer recorded/);
  });

  it('records a confirm yes answer', async () => {
    mockList.mockResolvedValue([makePendingRecord({ question: { type: 'confirm', message: 'Proceed?' } })]);
    mockAnswer.mockResolvedValue(true);
    const { ctx } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'q-1234567890-abcdef yes');
    expect(mockAnswer).toHaveBeenCalledWith('q-1234567890-abcdef', { value: true }, 'repl', undefined, 'repl');
  });

  it('records a confirm no answer', async () => {
    mockList.mockResolvedValue([makePendingRecord({ question: { type: 'confirm', message: 'Proceed?' } })]);
    mockAnswer.mockResolvedValue(true);
    const { ctx } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'q-1234567890-abcdef no');
    expect(mockAnswer).toHaveBeenCalledWith('q-1234567890-abcdef', { value: false }, 'repl', undefined, 'repl');
  });

  it('errors on invalid confirm value', async () => {
    mockList.mockResolvedValue([makePendingRecord({ question: { type: 'confirm', message: 'Proceed?' } })]);
    const { ctx, output } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'q-1234567890-abcdef maybe');
    expect(output.errors[0]).toMatch(/confirm question/);
    expect(mockAnswer).not.toHaveBeenCalled();
  });

  it('records a number answer', async () => {
    mockList.mockResolvedValue([makePendingRecord({ question: { type: 'number', message: 'How many?' } })]);
    mockAnswer.mockResolvedValue(true);
    const { ctx } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'q-1234567890-abcdef 42');
    expect(mockAnswer).toHaveBeenCalledWith('q-1234567890-abcdef', { value: 42 }, 'repl', undefined, 'repl');
  });

  it('errors on non-numeric answer for number type', async () => {
    mockList.mockResolvedValue([makePendingRecord({ question: { type: 'number', message: 'How many?' } })]);
    const { ctx, output } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'q-1234567890-abcdef hello');
    expect(output.errors[0]).toMatch(/Expected a number/);
    expect(mockAnswer).not.toHaveBeenCalled();
  });

  it('records a choice answer by index', async () => {
    mockList.mockResolvedValue([makePendingRecord({
      question: { type: 'choice', message: 'Pick one:', choices: ['alpha', 'beta', 'gamma'] },
    })]);
    mockAnswer.mockResolvedValue(true);
    const { ctx } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'q-1234567890-abcdef 2');
    expect(mockAnswer).toHaveBeenCalledWith('q-1234567890-abcdef', { value: 'beta' }, 'repl', undefined, 'repl');
  });

  it('records a choice answer by value', async () => {
    mockList.mockResolvedValue([makePendingRecord({
      question: { type: 'choice', message: 'Pick one:', choices: ['alpha', 'beta', 'gamma'] },
    })]);
    mockAnswer.mockResolvedValue(true);
    const { ctx } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'q-1234567890-abcdef gamma');
    expect(mockAnswer).toHaveBeenCalledWith('q-1234567890-abcdef', { value: 'gamma' }, 'repl', undefined, 'repl');
  });

  // --- Finding fixes ---

  it('errors on ambiguous prefix match (>1 result)', async () => {
    mockList.mockResolvedValue([
      makePendingRecord({ taskId: 'q-aaa-111' }),
      makePendingRecord({ taskId: 'q-aaa-222' }),
    ]);
    const { ctx, output } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'q-aaa answer');
    expect(output.errors[0]).toMatch(/Ambiguous id prefix/);
    expect(mockAnswer).not.toHaveBeenCalled();
  });

  it('rejects "2oops" as an invalid choice index (parseInt guard)', async () => {
    mockList.mockResolvedValue([makePendingRecord({
      question: { type: 'choice', message: 'Pick:', choices: ['alpha', 'beta', 'gamma'] },
    })]);
    const { ctx, output } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'q-1234567890-abcdef 2oops');
    expect(output.errors[0]).toMatch(/does not match any choice/);
    expect(mockAnswer).not.toHaveBeenCalled();
  });

  it('validates number answer against min bound', async () => {
    mockList.mockResolvedValue([makePendingRecord({
      question: { type: 'number', message: 'Rate:', min: 1, max: 10 },
    })]);
    const { ctx, output } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'q-1234567890-abcdef 0');
    expect(output.errors[0]).toMatch(/>= 1/);
    expect(mockAnswer).not.toHaveBeenCalled();
  });

  it('accepts number equal to min bound', async () => {
    mockList.mockResolvedValue([makePendingRecord({
      question: { type: 'number', message: 'Rate:', min: 1, max: 10 },
    })]);
    mockAnswer.mockResolvedValue(true);
    const { ctx } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'q-1234567890-abcdef 1');
    expect(mockAnswer).toHaveBeenCalledWith('q-1234567890-abcdef', { value: 1 }, 'repl', undefined, 'repl');
  });

  it('validates number answer against max bound', async () => {
    mockList.mockResolvedValue([makePendingRecord({
      question: { type: 'number', message: 'Rate:', min: 1, max: 10 },
    })]);
    const { ctx, output } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'q-1234567890-abcdef 11');
    expect(output.errors[0]).toMatch(/<= 10/);
    expect(mockAnswer).not.toHaveBeenCalled();
  });

  it('accepts number equal to max bound', async () => {
    mockList.mockResolvedValue([makePendingRecord({
      question: { type: 'number', message: 'Rate:', min: 1, max: 10 },
    })]);
    mockAnswer.mockResolvedValue(true);
    const { ctx } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'q-1234567890-abcdef 10');
    expect(mockAnswer).toHaveBeenCalledWith('q-1234567890-abcdef', { value: 10 }, 'repl', undefined, 'repl');
  });

  it('accepts custom value for choice with allowCustom', async () => {
    mockList.mockResolvedValue([makePendingRecord({
      question: { type: 'choice', message: 'Pick:', choices: ['alpha', 'beta'], allowCustom: true },
    })]);
    mockAnswer.mockResolvedValue(true);
    const { ctx } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'q-1234567890-abcdef something-custom');
    expect(mockAnswer).toHaveBeenCalledWith(
      'q-1234567890-abcdef',
      { value: null, custom_value: 'something-custom' },
      'repl', undefined, 'repl',
    );
  });

  it('allowCustom with input matching a listed choice sends canonical { value }, not custom_value', async () => {
    mockList.mockResolvedValue([makePendingRecord({
      question: { type: 'choice', message: 'Pick:', choices: ['alpha', 'beta'], allowCustom: true },
    })]);
    mockAnswer.mockResolvedValue(true);
    const { ctx } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'q-1234567890-abcdef alpha');
    expect(mockAnswer).toHaveBeenCalledWith(
      'q-1234567890-abcdef',
      { value: 'alpha' },
      'repl', undefined, 'repl',
    );
  });

  it('warns when handoff already answered (won: false)', async () => {
    mockList.mockResolvedValue([makePendingRecord()]);
    mockAnswer.mockResolvedValue(false);
    const { ctx, output } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'q-1234567890-abcdef Alice');
    expect(output.warns[0]).toMatch(/already answered/);
  });

  it('errors when answerHandoff throws', async () => {
    mockList.mockResolvedValue([makePendingRecord()]);
    mockAnswer.mockRejectedValue(new Error('lock error'));
    const { ctx, output } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'q-1234567890-abcdef Alice');
    expect(output.errors[0]).toMatch(/lock error/);
  });

  it('errors when listPendingHandoffs throws in answer handler', async () => {
    mockList.mockRejectedValue(new Error('store unavailable'));
    const { ctx, output } = makeCtx();
    await handoffsAnswerCmd.handler(ctx, 'q-1234567890-abcdef Alice');
    expect(output.errors[0]).toMatch(/store unavailable/);
  });
});
