import { describe, expect, it } from 'vitest';
import { BudgetExceededError, TimeoutError } from '../utils/errors.js';
import { abortFailureClass, providerAbortReason } from './abort-reason.js';
import { BENIGN_FAILURE_CLASSES } from './trace/types.js';

function abortedSignal(reason: unknown): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

describe('abort reason classification', () => {
  it.each([
    [new TimeoutError('session', 100), 'timeout'],
    [new BudgetExceededError(2, 1), 'budget'],
    ['Budget $2.00 exceeded limit of $1.00', 'budget'],
    ['session timed out after 100ms', 'timeout'],
    ['sigint', 'interrupted'],
  ] as const)('maps %o to %s', (reason, expected) => {
    expect(providerAbortReason(reason)).toBe(expected);
  });

  it('keeps user interruption benign while timeout and budget remain visible', () => {
    expect(abortFailureClass(abortedSignal('interrupted'))).toBe('abort');
    expect(BENIGN_FAILURE_CLASSES.has(abortFailureClass(abortedSignal('interrupted')))).toBe(true);
    expect(BENIGN_FAILURE_CLASSES.has(abortFailureClass(abortedSignal('timeout')))).toBe(false);
    expect(BENIGN_FAILURE_CLASSES.has(abortFailureClass(abortedSignal('budget')))).toBe(false);
  });
});
