/**
 * Agent-question (`ask_question`) elicitation rendering — overlay pickers,
 * text/number overlays, and non-TTY readLine fallbacks.
 *
 * History: extracted verbatim from `elicitation-repl.ts` (#367).
 */

import type { ElicitationRequest, ElicitationResult } from '../../agent/types/sdk-types.js';
import { renderMultiSelector, renderSelector, CUSTOM_ANSWER_SENTINEL } from '../input/selectors.js';
import { sanitizeSchemaString } from '../_lib/sanitize.js';
import { palette } from '../palette.js';
import { validateNumberField, validateTextField } from './field-validation.js';
import type { ReplElicitationDeps } from './repl-shared.js';
import { DECLINE, CANCEL } from './repl-shared.js';

// ---------------------------------------------------------------------------
// Agent-question mode
// ---------------------------------------------------------------------------

export const SKIP: ElicitationResult = { action: 'skip' };

/**
 * Build the overlay header lines that render INSIDE the picker frame
 * for both `pickFromList` and `readTextOverlay`. Lifted into a helper
 * so all overlay paths surface the same envelope (banner + question +
 * optional context) and vanish on confirm/cancel — only the single
 * `✓ <answer>` echo line below survives in scrollback.
 *
 * Layout (4 lines max):
 *   💬 Agent question
 *   ? <bold question>
 *     <dim context, optional>
 *   <trailing blank — visual breathing room before the input/options row>
 */
function buildOverlayHeader(request: ElicitationRequest): readonly string[] {
  const lines: string[] = [];
  lines.push(palette.warning('  💬 Agent question'));
  lines.push(palette.bold('  ? ' + sanitizeSchemaString(request.message, 512)));
  if (request.context) {
    lines.push(palette.dim('    ' + sanitizeSchemaString(request.context, 512)));
  }
  lines.push('');
  return lines;
}

/**
 * Discriminated outcome from {@link runOverlayTextOrNumber}. Lets the
 * caller distinguish text-shaped from number-shaped successful answers
 * (preserving the original `value` type) from the explicit-skip path
 * (`allowSkip` + empty buffer).
 */
type OverlayTextOutcome =
  | { tag: 'text'; value: string }
  | { tag: 'number'; value: number }
  | { tag: 'skip' };

/**
 * Run the text/number overlay against `readTextOverlay`. Returns:
 *   - `null` when the user cancelled (Esc / Ctrl+C / abort).
 *   - `{ tag: 'text', value }` for `qType === 'text'` on confirm.
 *   - `{ tag: 'number', value }` for `qType === 'number'` on confirm.
 *   - `{ tag: 'skip' }` when `allowSkip` is set and the buffer is empty.
 *
 * Validation is the synchronous `validate` callback handed to the
 * overlay — it loops the overlay on bad input (e.g. non-numeric for
 * `number`, below-min-length for `text`) so the user can correct in
 * place without the chrome flicker of a re-prompt.
 */
async function runOverlayTextOrNumber(
  qType: 'text' | 'number',
  request: ElicitationRequest,
  readTextOverlay: NonNullable<ReplElicitationDeps['readTextOverlay']>,
  signal: AbortSignal,
): Promise<OverlayTextOutcome | null> {
  const header = buildOverlayHeader(request);
  const allowSkip = request.allowSkip === true;

  if (qType === 'number') {
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

    const help = `enter to submit · esc to cancel${boundsHint}`;
    const validate = (raw: string): string | null => {
      const r = validateNumberField(raw.trim(), {
        allowSkip,
        min: minVal,
        max: maxVal,
        emptyError: 'Please enter a number (or esc to cancel).',
      });
      return r.ok ? null : r.error;
    };

    const result = await readTextOverlay({ header, help, validate, signal });
    if (result === null) return null;
    const trimmed = result.trim();
    if (trimmed === '' && allowSkip) return { tag: 'skip' };
    // validate guarantees this parses (allowSkip + empty already returned)
    return { tag: 'number', value: Number(trimmed) };
  }

  // text
  const minLen = request.minLength;
  const maxLen = request.maxLength;
  const validate = (raw: string): string | null => {
    const r = validateTextField(raw, {
      allowSkip,
      minLength: minLen,
      maxLength: maxLen,
      emptyError: 'Please enter a response (or esc to cancel).',
    });
    return r.ok ? null : r.error;
  };

  const result = await readTextOverlay({ header, validate, signal });
  if (result === null) return null;
  if (result === '' && allowSkip) return { tag: 'skip' };
  return { tag: 'text', value: result };
}

/**
 * Render an agent-originated `ask_question` request to the REPL.
 * Called when `request.origin === 'agent'`.
 */
export async function renderAgentQuestion(
  request: ElicitationRequest,
  deps: ReplElicitationDeps,
  signal: AbortSignal,
): Promise<ElicitationResult> {
  if (signal.aborted) return DECLINE;

  const { readLine, writer, pendingCount, pickFromList, readTextOverlay } = deps;
  const qType = request.type ?? 'text';

  // Queue-depth notice survives in scrollback so the user can see how
  // many more questions are queued even after the current overlay
  // vanishes. All other envelope chrome (banner, question, context)
  // moves INSIDE the overlay frame below — see {@link buildOverlayHeader}.
  const depth = pendingCount();
  if (depth > 1) {
    writer.line(palette.dim(`  [${depth} questions queued]`));
  }

  // Picker path for choice / multi_choice. The question prompt, options,
  // and help line ALL render inside the picker frame so they vanish on
  // confirm/cancel — only the single-line result echo persists in
  // scrollback. Falls back to numbered-text below when pickFromList is
  // absent (non-TTY: daemon, pipes, tests that don't exercise picker UX).
  if ((qType === 'choice' || qType === 'multi_choice') && pickFromList && (request.choices?.length ?? 0) > 0) {
    const sanitizedOptions = (request.choices ?? []).map((c) => sanitizeSchemaString(c, 128));
    if (request.allowCustom) sanitizedOptions.push(CUSTOM_ANSWER_SENTINEL);
    let selected: readonly string[] | null;
    try {
      selected = await pickFromList({
        header: buildOverlayHeader(request),
        options: sanitizedOptions,
        multi: qType === 'multi_choice',
        signal,
      });
    } catch {
      return CANCEL;
    }
    if (signal.aborted) return CANCEL;
    if (selected === null) return CANCEL;

    // Custom-answer path — sentinel present. In a multi-select the sentinel can
    // be checked alongside real options; treat its presence (not exclusivity) as
    // the signal to switch to free-form entry, so the sentinel label never leaks
    // into `value` and we never index choices[] out of range below.
    if (request.allowCustom && selected.includes(CUSTOM_ANSWER_SENTINEL)) {
      if (!readTextOverlay) return CANCEL;
      const customText = await readTextOverlay({
        header: buildOverlayHeader(request),
        help: 'Type your custom answer (Esc to cancel)',
        validate: (v) => v.trim() === '' ? 'Please enter a non-empty answer' : null,
        signal,
      });
      if (customText === null) return CANCEL;
      writer.line(palette.dim('  \u270E ') + palette.brand(sanitizeSchemaString(customText, 256)));
      return { action: 'accept', content: { value: null, custom_value: customText } };
    }

    if (selected.length === 0) {
      if (request.allowSkip) return SKIP;
      // Confirmed multi-select with no items selected. Treat as cancel
      // when skip is disallowed — there is no useful answer to return.
      return CANCEL;
    }

    // Single-line result echo — survives in scrollback so the user
    // can see what they answered. Brand-coloured selection, dim prefix.
    const echoLabel = selected.length === 1
      ? sanitizeSchemaString(selected[0] ?? '', 128)
      : selected.map((s) => sanitizeSchemaString(s, 128)).join(', ');
    writer.line(palette.dim('  ✓ ') + palette.brand(echoLabel));

    if (qType === 'choice') {
      return { action: 'accept', content: { value: selected[0] } };
    }
    return { action: 'accept', content: { value: [...selected] } };
  }

  // Confirm-as-picker: reuse the arrow-key picker with a Yes / No
  // two-option list. Same overlay-frame vanish behaviour as choice;
  // the default value (Y/n vs y/N) controls which option starts
  // highlighted. Falls back to readLine y/n below when pickFromList
  // is absent (non-TTY surfaces).
  if (qType === 'confirm' && pickFromList) {
    const yesFirst = request.questionDefault !== false;
    const options = yesFirst ? ['Yes', 'No'] : ['No', 'Yes'];
    let selected: readonly string[] | null;
    try {
      selected = await pickFromList({
        header: buildOverlayHeader(request),
        options,
        multi: false,
        signal,
      });
    } catch {
      return CANCEL;
    }
    if (signal.aborted) return CANCEL;
    if (selected === null) return CANCEL;
    const picked = selected[0];
    if (picked === undefined) return CANCEL;
    const yes = picked === 'Yes';
    writer.line(
      palette.dim('  ✓ ') + (yes ? palette.success('Yes') : palette.error('No')),
    );
    return { action: 'accept', content: { value: yes } };
  }

  // Text / number overlay path — same vanish-on-confirm shape as the
  // picker. Validation runs on Enter; failure keeps the overlay open
  // with the error rendered below the input row. Falls back to the
  // legacy readLine numbered path when the dep is absent (non-TTY
  // surfaces, daemon, pipes, tests that don't wire the overlay).
  if ((qType === 'text' || qType === 'number') && readTextOverlay) {
    const result = await runOverlayTextOrNumber(qType, request, readTextOverlay, signal);
    if (result === null) return CANCEL;
    if (result.tag === 'skip') return SKIP;

    const echo = result.tag === 'text'
      ? sanitizeSchemaString(result.value, 256)
      : String(result.value);
    writer.line(palette.dim('  ✓ ') + palette.brand(echo));
    return {
      action: 'accept',
      content: { value: result.tag === 'text' ? result.value : result.value },
    };
  }

  // Non-overlay fallback paths: question + help line stay in scrollback
  // (no overlay to absorb them). Daemon / non-TTY / unit-test surfaces
  // land here when no overlay deps were wired.
  writer.line();
  writer.line(palette.warning('💬 Agent question'));
  if (request.context) {
    writer.line(palette.dim('  context: ') + sanitizeSchemaString(request.context, 512));
  }
  writer.line(palette.bold('  ' + sanitizeSchemaString(request.message, 512)));
  writer.line(palette.dim('  Type :cancel to skip this question.'));
  writer.line();

  if (qType === 'confirm') {
    writer.line('\x07');
    const defaultHint = request.questionDefault === true ? 'Y/n' : 'y/N';
    while (true) {
      if (signal.aborted) return CANCEL;
      let input: string;
      try {
        input = (await readLine(palette.dim(`  Continue? [${defaultHint}] `))).trim().toLowerCase();
      } catch {
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

  // Numbered-text fallback for `choice` / `multi_choice` when no
  // pickFromList is available (non-TTY surfaces and tests that don't
  // inject the picker dependency). Behaviour identical to the pre-picker
  // implementation so daemon / piped sessions keep working unchanged.
  if (qType === 'choice') {
    writer.line('\x07');
    const choices = request.choices ?? [];

    // Interactive arrow-key selector (TTY path). suspendInput has already
    // released the compositor's raw-mode; the selector re-enters raw mode
    // for its own keypress handling and exits it before returning.
    const choicesForSelector = request.allowCustom ? [...choices, CUSTOM_ANSWER_SENTINEL] : choices;
    const selectorResult = await renderSelector(choicesForSelector, signal);
    if (selectorResult !== null) {
      // TTY path — selector handled it
      if (selectorResult === ':cancel') return CANCEL;
      // Sentinel index = original choices.length
      if (request.allowCustom && selectorResult === choices.length) {
        let input: string;
        try { input = (await readLine(palette.dim('  Type your answer: '))).trim(); } catch { return CANCEL; }
        if (input === ':cancel' || signal.aborted) return CANCEL;
        return { action: 'accept', content: { value: null, custom_value: input } };
      }
      const chosen = choices[selectorResult];
      if (chosen !== undefined) {
        writer.line(palette.dim(`  Selected: ${sanitizeSchemaString(chosen, 128)}`));
        return { action: 'accept', content: { value: chosen } };
      }
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
      } catch {
        return CANCEL;
      }
      if (signal.aborted) return CANCEL;
      if (input === ':cancel') return CANCEL;
      if (request.allowCustom && input === String(choices.length + 1)) {
        let custom: string;
        try { custom = (await readLine(palette.dim('  Type your answer: '))).trim(); } catch { return CANCEL; }
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

  if (qType === 'multi_choice') {
    const choices = request.choices ?? [];

    // Interactive arrow-key multi-selector (TTY path)
    const choicesForMultiSelector = request.allowCustom ? [...choices, CUSTOM_ANSWER_SENTINEL] : choices;
    const selectorResult = await renderMultiSelector(choicesForMultiSelector, signal);
    if (selectorResult !== null) {
      if (selectorResult === ':cancel') return CANCEL;
      // Sentinel index = original choices.length. Presence (even alongside real
      // picks) routes to free-form entry — otherwise choices[choices.length] is
      // undefined and leaks into `values` / throws in sanitizeSchemaString.
      if (request.allowCustom && selectorResult.includes(choices.length)) {
        let input: string;
        try { input = (await readLine(palette.dim('  Type your answer: '))).trim(); } catch { return CANCEL; }
        if (input === ':cancel' || signal.aborted) return CANCEL;
        return { action: 'accept', content: { value: null, custom_value: input } };
      }
      if (selectorResult.length === 0 && request.allowSkip) return SKIP;
      if (selectorResult.length > 0) {
        const values = selectorResult.map((i) => choices[i]!);
        writer.line(palette.dim(`  Selected: ${values.map((v) => sanitizeSchemaString(v, 64)).join(', ')}`));
        return { action: 'accept', content: { value: values } };
      }
      // Empty selection with allowSkip=false — fall through to text entry
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
      } catch {
        return CANCEL;
      }
      if (signal.aborted) return CANCEL;
      if (input === ':cancel') return CANCEL;
      if (request.allowCustom && input === String(choices.length + 1)) {
        let custom: string;
        try { custom = (await readLine(palette.dim('  Type your answer: '))).trim(); } catch { return CANCEL; }
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
          writer.line(palette.warning(`  Invalid selection "${sanitizeSchemaString(part, 32)}". Enter numbers between 1 and ${choices.length}.`));
          valid = false;
          break;
        }
        selected.push(choices[idx - 1]!);
      }
      if (!valid) continue;
      return { action: 'accept', content: { value: selected } };
    }
  }

  if (qType === 'number') {
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
      } catch {
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

  // Default: text
  const minLen = request.minLength;
  const maxLen = request.maxLength;
  while (true) {
    if (signal.aborted) return CANCEL;
    let input: string;
    try {
      input = (await readLine(palette.dim('  > '))).trim();
    } catch {
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
