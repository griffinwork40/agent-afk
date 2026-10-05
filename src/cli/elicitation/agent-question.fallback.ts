/**
 * Non-overlay (readLine) fallback renderers for agent-question elicitation.
 *
 * These paths handle daemon / non-TTY / unit-test surfaces where overlay
 * deps (pickFromList, readTextOverlay) are absent. Extracted from
 * agent-question.ts to bring renderAgentQuestion under the 350-line ceiling.
 *
 * Exports: renderConfirmFallback, renderChoiceFallback,
 * renderMultiChoiceFallback, renderNumberFallback, renderTextFallback.
 * All are self-contained async functions that take explicit parameters.
 */

import type { ElicitationRequest, ElicitationResult } from '../../agent/types/sdk-types.js';
import { debugLog } from '../../utils/debug.js';
import { renderMultiSelector, renderSelector, CUSTOM_ANSWER_SENTINEL } from '../input/selectors.js';
import { sanitizeSchemaString } from '../_lib/sanitize.js';
import { palette } from '../palette.js';
import { validateNumberField, validateTextField } from './field-validation.js';
import type { ReplElicitationDeps } from './repl-shared.js';
import { CANCEL } from './repl-shared.js';

export const SKIP: ElicitationResult = { action: 'skip' };

type Writer = ReplElicitationDeps['writer'];
type ReadLine = ReplElicitationDeps['readLine'];

// ---------------------------------------------------------------------------
// renderConfirmFallback
// ---------------------------------------------------------------------------

/**
 * Non-overlay confirm path: readLine y/n loop.
 * Used when `pickFromList` is absent (daemon, non-TTY, tests without picker).
 */
export async function renderConfirmFallback(
  request: ElicitationRequest,
  readLine: ReadLine,
  writer: Writer,
  signal: AbortSignal,
): Promise<ElicitationResult> {
  writer.line('\x07');
  const defaultHint = request.questionDefault === true ? 'Y/n' : 'y/N';
  while (true) {
    if (signal.aborted) return CANCEL;
    let input: string;
    try {
      input = (await readLine(palette.dim(`  Continue? [${defaultHint}] `))).trim().toLowerCase();
    } catch (err) {
      debugLog('[elicitation] confirm readLine failed:', err);
      return CANCEL;
    }
    if (signal.aborted) return CANCEL;
    if (input === ':cancel') return CANCEL;
    if (input === '') {
      return { action: 'accept', content: { value: request.questionDefault === true } };
    }
    if (input === 'y' || input === 'yes') return { action: 'accept', content: { value: true } };
    if (input === 'n' || input === 'no') return { action: 'accept', content: { value: false } };
    writer.line(palette.warning('  Please enter y or n.'));
  }
}

// ---------------------------------------------------------------------------
// renderChoiceFallback
// ---------------------------------------------------------------------------

/**
 * Non-overlay choice path: arrow-key selector (TTY) or numbered list (non-TTY).
 * Used when `pickFromList` is absent.
 */
export async function renderChoiceFallback(
  request: ElicitationRequest,
  readLine: ReadLine,
  writer: Writer,
  signal: AbortSignal,
): Promise<ElicitationResult> {
  writer.line('\x07');
  const choices = request.choices ?? [];

  const choicesForSelector = request.allowCustom ? [...choices, CUSTOM_ANSWER_SENTINEL] : choices;
  const selectorResult = await renderSelector(choicesForSelector, signal);
  if (selectorResult !== null) {
    if (selectorResult === ':cancel') return CANCEL;
    if (request.allowCustom && selectorResult === choices.length) {
      let input: string;
      try {
        input = (await readLine(palette.dim('  Type your answer: '))).trim();
      } catch (err) {
        debugLog('[elicitation] custom-answer readLine failed:', err);
        return CANCEL;
      }
      if (input === ':cancel' || signal.aborted) return CANCEL;
      return { action: 'accept', content: { value: null, custom_value: input } };
    }
    const chosen = choices[selectorResult];
    if (chosen !== undefined) {
      writer.line(palette.dim(`  Selected: ${sanitizeSchemaString(chosen, 128)}`));
      return { action: 'accept', content: { value: chosen } };
    }
    debugLog('[elicitation] choice selector returned an out-of-range index:', {
      selectorResult,
      choicesLength: choices.length,
    });
    return CANCEL;
  }

  // Non-TTY / fallback: numbered list + text entry
  choices.forEach((c, i) => {
    writer.line(`  ${i + 1}. ${sanitizeSchemaString(c, 128)}`);
  });
  if (request.allowCustom) {
    writer.line(`  ${choices.length + 1}. ${CUSTOM_ANSWER_SENTINEL}`);
  }
  while (true) {
    if (signal.aborted) return CANCEL;
    let input: string;
    try {
      input = (await readLine(palette.dim('  Enter number: '))).trim();
    } catch (err) {
      debugLog('[elicitation] choice readLine failed:', err);
      return CANCEL;
    }
    if (signal.aborted) return CANCEL;
    if (input === ':cancel') return CANCEL;
    if (request.allowCustom && input === String(choices.length + 1)) {
      let custom: string;
      try {
        custom = (await readLine(palette.dim('  Type your answer: '))).trim();
      } catch (err) {
        debugLog('[elicitation] custom-answer readLine failed:', err);
        return CANCEL;
      }
      if (custom === ':cancel') return CANCEL;
      return { action: 'accept', content: { value: null, custom_value: custom } };
    }
    if (input === '' && request.allowSkip) return SKIP;
    const idx = parseInt(input, 10);
    if (!isFinite(idx) || String(idx) !== input || idx < 1 || idx > choices.length) {
      writer.line(palette.warning(`  Please enter a number between 1 and ${choices.length + (request.allowCustom ? 1 : 0)}.`));
      continue;
    }
    return { action: 'accept', content: { value: choices[idx - 1] } };
  }
}

// ---------------------------------------------------------------------------
// renderMultiChoiceFallback
// ---------------------------------------------------------------------------

/**
 * Non-overlay multi_choice path: arrow-key multi-selector (TTY) or
 * comma-separated numbered list (non-TTY).
 * Used when `pickFromList` is absent.
 */
export async function renderMultiChoiceFallback(
  request: ElicitationRequest,
  readLine: ReadLine,
  writer: Writer,
  signal: AbortSignal,
): Promise<ElicitationResult> {
  writer.line('\x07');
  const choices = request.choices ?? [];

  const choicesForMultiSelector = request.allowCustom ? [...choices, CUSTOM_ANSWER_SENTINEL] : choices;
  const selectorResult = await renderMultiSelector(choicesForMultiSelector, signal);
  if (selectorResult !== null) {
    if (selectorResult === ':cancel') return CANCEL;
    if (request.allowCustom && selectorResult.includes(choices.length)) {
      let input: string;
      try {
        input = (await readLine(palette.dim('  Type your answer: '))).trim();
      } catch (err) {
        debugLog('[elicitation] custom-answer readLine failed:', err);
        return CANCEL;
      }
      if (input === ':cancel' || signal.aborted) return CANCEL;
      return { action: 'accept', content: { value: null, custom_value: input } };
    }
    if (selectorResult.length === 0 && request.allowSkip) return SKIP;
    if (selectorResult.length > 0) {
      const values = selectorResult.map((i) => choices[i]!);
      writer.line(palette.dim(`  Selected: ${values.map((v) => sanitizeSchemaString(v, 64)).join(', ')}`));
      return { action: 'accept', content: { value: values } };
    }
    // Empty selection with allowSkip=false -- fall through to text entry
  }

  // Non-TTY / fallback: numbered list + comma-separated text entry
  choices.forEach((c, i) => {
    writer.line(`  ${i + 1}. ${sanitizeSchemaString(c, 128)}`);
  });
  if (request.allowCustom) {
    writer.line(`  ${choices.length + 1}. ${CUSTOM_ANSWER_SENTINEL}`);
  }
  while (true) {
    if (signal.aborted) return CANCEL;
    let input: string;
    try {
      input = (await readLine(palette.dim('  Enter numbers (comma-separated): '))).trim();
    } catch (err) {
      debugLog('[elicitation] multi_choice readLine failed:', err);
      return CANCEL;
    }
    if (signal.aborted) return CANCEL;
    if (input === ':cancel') return CANCEL;
    if (request.allowCustom && input === String(choices.length + 1)) {
      let custom: string;
      try {
        custom = (await readLine(palette.dim('  Type your answer: '))).trim();
      } catch (err) {
        debugLog('[elicitation] custom-answer readLine failed:', err);
        return CANCEL;
      }
      if (custom === ':cancel') return CANCEL;
      return { action: 'accept', content: { value: null, custom_value: custom } };
    }
    if (input === '' && request.allowSkip) return SKIP;
    if (input === '') {
      writer.line(palette.warning('  Please enter at least one selection.'));
      continue;
    }
    const parts = input.split(',').map((s) => s.trim());
    const selected: string[] = [];
    let valid = true;
    for (const part of parts) {
      const idx = parseInt(part, 10);
      if (!isFinite(idx) || String(idx) !== part || idx < 1 || idx > choices.length) {
        writer.line(palette.warning(`  Invalid selection "${sanitizeSchemaString(part, 32)}". Enter numbers between 1 and ${choices.length + (request.allowCustom ? 1 : 0)}.`));
        valid = false;
        break;
      }
      selected.push(choices[idx - 1]!);
    }
    if (!valid) continue;
    return { action: 'accept', content: { value: selected } };
  }
}

// ---------------------------------------------------------------------------
// renderNumberFallback
// ---------------------------------------------------------------------------

/**
 * Non-overlay number path: readLine loop with validation.
 * Used when `readTextOverlay` is absent.
 */
export async function renderNumberFallback(
  request: ElicitationRequest,
  readLine: ReadLine,
  writer: Writer,
  signal: AbortSignal,
): Promise<ElicitationResult> {
  const minVal = request.min;
  const maxVal = request.max;
  const boundsHint =
    minVal !== undefined && maxVal !== undefined
      ? ` [${minVal}\u2013${maxVal}]`
      : minVal !== undefined
      ? ` [\u2265${minVal}]`
      : maxVal !== undefined
      ? ` [\u2264${maxVal}]`
      : '';
  while (true) {
    if (signal.aborted) return CANCEL;
    let input: string;
    try {
      input = (await readLine(palette.dim(`  Enter a number${boundsHint}: `))).trim();
    } catch (err) {
      debugLog('[elicitation] number readLine failed:', err);
      return CANCEL;
    }
    if (signal.aborted) return CANCEL;
    if (input === ':cancel') return CANCEL;
    const r = validateNumberField(input, {
      allowSkip: request.allowSkip === true,
      min: minVal,
      max: maxVal,
      emptyError: 'Please enter a number (or :cancel to skip).',
    });
    if (!r.ok) {
      writer.line(palette.warning('  ' + r.error));
      continue;
    }
    if (r.skip) return SKIP;
    return { action: 'accept', content: { value: r.value } };
  }
}

// ---------------------------------------------------------------------------
// renderTextFallback
// ---------------------------------------------------------------------------

/**
 * Non-overlay text path (default): readLine loop with validation.
 * Used when `readTextOverlay` is absent.
 */
export async function renderTextFallback(
  request: ElicitationRequest,
  readLine: ReadLine,
  writer: Writer,
  signal: AbortSignal,
): Promise<ElicitationResult> {
  const minLen = request.minLength;
  const maxLen = request.maxLength;
  while (true) {
    if (signal.aborted) return CANCEL;
    let input: string;
    try {
      input = (await readLine(palette.dim('  > '))).trim();
    } catch (err) {
      debugLog('[elicitation] text readLine failed:', err);
      return CANCEL;
    }
    if (signal.aborted) return CANCEL;
    if (input === ':cancel') return CANCEL;
    const r = validateTextField(input, {
      allowSkip: request.allowSkip === true,
      minLength: minLen,
      maxLength: maxLen,
      emptyError: 'Please enter a response (or type :cancel to skip).',
    });
    if (!r.ok) {
      writer.line(palette.warning('  ' + r.error));
      continue;
    }
    if (r.skip) return SKIP;
    return { action: 'accept', content: { value: input } };
  }
}
