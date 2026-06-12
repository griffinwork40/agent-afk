/**
 * Handler for the `ask_question` built-in tool.
 *
 * Routes a structured question from the agent to the currently-installed
 * elicitation surface (REPL or Telegram). If no handler is installed,
 * `elicitationRouter.route()` auto-declines and the agent receives
 * `{ action: 'decline' }` — no exception is ever thrown.
 *
 * @module agent/tools/handlers/ask-question
 */

import type { ToolHandler } from '../types.js';
import type { ElicitationRequest } from '../../types/sdk-types.js';
import { elicitationRouter } from '../../elicitation-router.js';

export const askQuestionHandler: ToolHandler = async (input, signal) => {
  if (!input || typeof input !== 'object') {
    return { content: 'Invalid input: expected an object', isError: true };
  }

  const obj = input as Record<string, unknown>;

  // `question` is required
  const question = obj['question'];
  if (typeof question !== 'string' || question.trim() === '') {
    return { content: 'Invalid input: question must be a non-empty string', isError: true };
  }

  // Validate `type`
  const VALID_TYPES = new Set(['text', 'confirm', 'choice', 'multi_choice', 'number']);
  const qType = obj['type'] ?? 'text';
  if (typeof qType !== 'string' || !VALID_TYPES.has(qType)) {
    return {
      content: `Invalid input: type must be one of: text, confirm, choice, multi_choice, number`,
      isError: true,
    };
  }

  // `choices` required for choice/multi_choice
  if (qType === 'choice' || qType === 'multi_choice') {
    const choices = obj['choices'];
    if (!Array.isArray(choices) || choices.length === 0) {
      return {
        content: `Invalid input: choices array is required and must be non-empty for type "${qType}"`,
        isError: true,
      };
    }
    // M1: guard against unbounded choice arrays that would overflow Telegram keyboards
    // or cause excessive memory/rendering cost on any surface.
    if (choices.length > 100) {
      return {
        content: `Invalid input: choices array must not exceed 100 items, got ${choices.length}`,
        isError: true,
      };
    }
    for (const c of choices) {
      if (typeof c !== 'string') {
        return {
          content: 'Invalid input: all choices must be strings',
          isError: true,
        };
      }
    }
  }

  // Validate numeric bounds
  const min = obj['min'];
  const max = obj['max'];
  if (min !== undefined && (typeof min !== 'number' || !Number.isFinite(min))) {
    return { content: 'Invalid input: min must be a finite number', isError: true };
  }
  if (max !== undefined && (typeof max !== 'number' || !Number.isFinite(max))) {
    return { content: 'Invalid input: max must be a finite number', isError: true };
  }
  if (min !== undefined && max !== undefined && (min as number) > (max as number)) {
    return {
      content: `Invalid input: min (${min}) must be \u2264 max (${max})`,
      isError: true,
    };
  }

  // Validate minLength/maxLength
  const minLength = obj['min_length'];
  const maxLength = obj['max_length'];
  if (minLength !== undefined && typeof minLength !== 'number') {
    return { content: 'Invalid input: min_length must be a number', isError: true };
  }
  if (maxLength !== undefined && typeof maxLength !== 'number') {
    return { content: 'Invalid input: max_length must be a number', isError: true };
  }
  if ((minLength !== undefined || maxLength !== undefined) && qType !== 'text') {
    return {
      content: `Invalid input: min_length/max_length are only valid for type "text", got "${qType}"`,
      isError: true,
    };
  }

  if (obj['allow_custom'] !== undefined && qType !== 'choice' && qType !== 'multi_choice') {
    return {
      content: `Invalid input: allow_custom is only valid for type "choice" or "multi_choice", got "${qType}"`,
      isError: true,
    };
  }

  // Build the ElicitationRequest with origin: 'agent'
  const request: ElicitationRequest = {
    serverName: 'agent',
    message: question.trim(),
    origin: 'agent',
    type: qType as ElicitationRequest['type'],
    ...(obj['choices'] !== undefined && { choices: obj['choices'] as string[] }),
    ...(obj['context'] !== undefined && typeof obj['context'] === 'string' && {
      context: obj['context'],
    }),
    ...(obj['default'] !== undefined && {
      questionDefault: obj['default'] as string | boolean | number,
    }),
    ...(minLength !== undefined && { minLength: minLength as number }),
    ...(maxLength !== undefined && { maxLength: maxLength as number }),
    ...(min !== undefined && { min: min as number }),
    ...(max !== undefined && { max: max as number }),
    ...(obj['allow_skip'] !== undefined && { allowSkip: Boolean(obj['allow_skip']) }),
    ...(obj['allow_custom'] !== undefined && { allowCustom: Boolean(obj['allow_custom']) }),
  };

  const result = await elicitationRouter.route(request, { signal });
  // Contract: only `decline` (no handler installed) and `cancel` (user
  // interrupted) are surfaced to the agent as tool errors. `accept` and
  // `skip` are both successful outcomes — `skip` is the deliberate
  // "operator chose not to answer this optional question" path (gated on
  // `allow_skip: true`), and the agent receives `{ action: 'skip' }` in
  // the JSON content. The system prompt in agent/routing-directive.ts
  // documents this distinction: "skip (optional question skipped)" is a
  // listed action, while "After a `cancel` or `decline`, stop and tell the
  // user what information you need" only fires for the two error actions.
  const declined = result.action === 'decline' || result.action === 'cancel';
  return { content: JSON.stringify(result), ...(declined && { isError: true }) };
};
