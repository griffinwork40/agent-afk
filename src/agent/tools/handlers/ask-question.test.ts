/**
 * Tests for the `ask_question` tool handler.
 *
 * Uses the elicitation router's real interface but with the module-level
 * singleton — tests call elicitationRouter.install / uninstall to control
 * whether a handler is present.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { askQuestionHandler } from './ask-question.js';
import { elicitationRouter } from '../../elicitation-router.js';
import type { ElicitationResult, ElicitationRequest } from '../../types/sdk-types.js';

const NO_SIGNAL = new AbortController().signal;

beforeEach(() => {
  elicitationRouter.uninstall();
});
afterEach(() => {
  elicitationRouter.uninstall();
});

// ---------------------------------------------------------------------------
// Validation failures
// ---------------------------------------------------------------------------

describe('ask_question handler — validation', () => {
  it('returns isError when input is not an object', async () => {
    const result = await askQuestionHandler('bad', NO_SIGNAL);
    expect(result.isError).toBe(true);
  });

  it('returns isError when question is missing', async () => {
    const result = await askQuestionHandler({}, NO_SIGNAL);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/question/i);
  });

  it('returns isError when question is empty string', async () => {
    const result = await askQuestionHandler({ question: '   ' }, NO_SIGNAL);
    expect(result.isError).toBe(true);
  });

  it('returns isError for unknown type', async () => {
    const result = await askQuestionHandler({ question: 'hi?', type: 'multiselect' }, NO_SIGNAL);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/type/i);
  });

  it('returns isError for choice type without choices', async () => {
    const result = await askQuestionHandler({ question: 'pick one?', type: 'choice' }, NO_SIGNAL);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/choices/i);
  });

  it('returns isError for multi_choice type with empty choices array', async () => {
    const result = await askQuestionHandler(
      { question: 'pick some?', type: 'multi_choice', choices: [] },
      NO_SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/choices/i);
  });

  it('returns isError when choices contains non-strings', async () => {
    const result = await askQuestionHandler(
      { question: 'pick?', type: 'choice', choices: ['a', 42, 'b'] },
      NO_SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/strings/i);
  });

  it('returns isError when min > max', async () => {
    const result = await askQuestionHandler(
      { question: 'how many?', type: 'number', min: 10, max: 5 },
      NO_SIGNAL,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/min.*max|\u2264/i);
  });

  it('returns isError when min is not a number', async () => {
    const result = await askQuestionHandler(
      { question: 'how many?', type: 'number', min: 'ten' },
      NO_SIGNAL,
    );
    expect(result.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Accept paths — no handler installed -> auto-decline
// ---------------------------------------------------------------------------

describe('ask_question handler — decline when no handler', () => {
  it('returns { action: "decline" } with isError: true for text type when no handler installed', async () => {
    const result = await askQuestionHandler({ question: 'what is your name?' }, NO_SIGNAL);
    // M3: decline/cancel are hard stops — the agent must see isError: true so it
    // halts rather than treating the refusal as a valid answer.
    expect(result.isError).toBe(true);
    const parsed = JSON.parse(result.content as string) as ElicitationResult;
    expect(parsed.action).toBe('decline');
  });

  it('returns { action: "decline" } for confirm type when no handler installed', async () => {
    const result = await askQuestionHandler(
      { question: 'are you sure?', type: 'confirm' },
      NO_SIGNAL,
    );
    const parsed = JSON.parse(result.content as string) as ElicitationResult;
    expect(parsed.action).toBe('decline');
  });

  it('returns { action: "decline" } for choice type when no handler installed', async () => {
    const result = await askQuestionHandler(
      { question: 'pick one', type: 'choice', choices: ['a', 'b', 'c'] },
      NO_SIGNAL,
    );
    const parsed = JSON.parse(result.content as string) as ElicitationResult;
    expect(parsed.action).toBe('decline');
  });

  it('returns { action: "decline" } for multi_choice type when no handler installed', async () => {
    const result = await askQuestionHandler(
      { question: 'pick many', type: 'multi_choice', choices: ['x', 'y', 'z'] },
      NO_SIGNAL,
    );
    const parsed = JSON.parse(result.content as string) as ElicitationResult;
    expect(parsed.action).toBe('decline');
  });

  it('returns { action: "decline" } for number type when no handler installed', async () => {
    const result = await askQuestionHandler(
      { question: 'enter a number', type: 'number', min: 1, max: 100 },
      NO_SIGNAL,
    );
    const parsed = JSON.parse(result.content as string) as ElicitationResult;
    expect(parsed.action).toBe('decline');
  });
});

// ---------------------------------------------------------------------------
// Accept paths — handler installed
// ---------------------------------------------------------------------------

describe('ask_question handler — handler installed', () => {
  it('forwards accept result when handler accepts', async () => {
    const accepted: ElicitationResult = { action: 'accept', content: { answer: 'yes' } };
    elicitationRouter.install(vi.fn().mockResolvedValue(accepted));

    const result = await askQuestionHandler({ question: 'confirm?' }, NO_SIGNAL);
    expect(result.isError).toBeUndefined();
    const parsed = JSON.parse(result.content as string) as ElicitationResult;
    expect(parsed.action).toBe('accept');
  });

  it('passes origin: "agent" in the routed request', async () => {
    let capturedRequest: ElicitationRequest | undefined;
    elicitationRouter.install(async (req) => {
      capturedRequest = req;
      return { action: 'decline' };
    });

    await askQuestionHandler({ question: 'hello?', type: 'text' }, NO_SIGNAL);
    expect(capturedRequest?.origin).toBe('agent');
    expect(capturedRequest?.type).toBe('text');
    expect(capturedRequest?.message).toBe('hello?');
  });

  it('passes choices in the routed request', async () => {
    let capturedChoices: string[] | undefined;
    elicitationRouter.install(async (req) => {
      capturedChoices = req.choices;
      return { action: 'decline' };
    });

    await askQuestionHandler(
      { question: 'pick?', type: 'choice', choices: ['red', 'blue'] },
      NO_SIGNAL,
    );
    expect(capturedChoices).toEqual(['red', 'blue']);
  });

  it('passes context, min, max, allow_skip in the routed request', async () => {
    let captured: ElicitationRequest | undefined;
    elicitationRouter.install(async (req) => {
      captured = req;
      return { action: 'decline' };
    });

    await askQuestionHandler(
      {
        question: 'how many?',
        type: 'number',
        context: 'between 1 and 10',
        min: 1,
        max: 10,
        allow_skip: true,
      },
      NO_SIGNAL,
    );

    expect(captured?.context).toBe('between 1 and 10');
    expect(captured?.min).toBe(1);
    expect(captured?.max).toBe(10);
    expect(captured?.allowSkip).toBe(true);
  });
});
