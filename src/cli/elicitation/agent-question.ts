/**
 * Agent-question (`ask_question`) elicitation rendering — overlay pickers,
 * text/number overlays, and non-TTY readLine fallbacks.
 *
 * History: extracted verbatim from `elicitation-repl.ts` (#367).
 */

import type { ElicitationRequest, ElicitationResult } from '../../agent/types/sdk-types.js';
import { debugLog } from '../../utils/debug.js';
import { CUSTOM_ANSWER_SENTINEL } from '../input/selectors.js';
import { sanitizeSchemaString, sanitizeTerminalText } from '../_lib/sanitize.js';
import { palette } from '../palette.js';
import { getTerminalHeight, getTerminalWidth } from '../terminal-size.js';
import { layoutAgentQuestion } from './agent-question.layout.js';
import { validateNumberField, validateTextField } from './field-validation.js';
import type { ReplElicitationDeps } from './repl-shared.js';
import { DECLINE, CANCEL } from './repl-shared.js';
import {
  renderConfirmFallback,
  renderChoiceFallback,
  renderMultiChoiceFallback,
  renderNumberFallback,
  renderTextFallback,
  SKIP,
} from './agent-question.fallback.js';
// Re-export SKIP so existing importers of agent-question.ts are unchanged.
export { SKIP };

// ---------------------------------------------------------------------------
// Agent-question mode
// ---------------------------------------------------------------------------

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
  header: readonly string[],
  readTextOverlay: NonNullable<ReplElicitationDeps['readTextOverlay']>,
  signal: AbortSignal,
): Promise<OverlayTextOutcome | null> {
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
  // moves INSIDE the overlay frame below — see {@link layoutAgentQuestion}.
  const depth = pendingCount();
  if (depth > 1) {
    writer.line(palette.dim(`  [${depth} questions queued]`));
  }

  // Overlay envelope sized to the terminal (see agent-question.layout.ts).
  // When the full question cannot fit inside the overlay, its complete text
  // is written to scrollback BEFORE the overlay opens (never during picker
  // mode), so nothing the agent asked is only visible in truncated form.
  const size = deps.terminalSize?.() ?? { columns: getTerminalWidth(), rows: getTerminalHeight() };
  const layout = layoutAgentQuestion(request, size);
  const spillToScrollback = (): void => {
    for (const l of layout.scrollback) writer.line(l);
  };

  // Picker path for choice / multi_choice. The question prompt, options,
  // and help line ALL render inside the picker frame so they vanish on
  // confirm/cancel — only the single-line result echo persists in
  // scrollback. Falls back to numbered-text below when pickFromList is
  // absent (non-TTY: daemon, pipes, tests that don't exercise picker UX).
  if ((qType === 'choice' || qType === 'multi_choice') && pickFromList && (request.choices?.length ?? 0) > 0) {
    const pickerOptions = [...layout.options];
    if (request.allowCustom) pickerOptions.push(CUSTOM_ANSWER_SENTINEL);
    spillToScrollback();
    let selected: readonly string[] | null;
    try {
      selected = await pickFromList({
        header: layout.header,
        options: pickerOptions,
        multi: qType === 'multi_choice',
        signal,
      });
    } catch (err) {
      debugLog('[elicitation] choice/multi_choice pickFromList failed:', err);
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
        header: layout.header,
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
    // Map display labels back to the agent's ORIGINAL choice strings: labels
    // are sanitized and may be shortened/numbered to fit one row, and the
    // agent must receive a value that exactly matches one of its choices.
    const values = selected.map((label) => layout.choiceFor(label));
    if (values.some((v) => v === undefined)) {
      debugLog('[elicitation] picker returned a label with no matching choice:', selected);
      return CANCEL;
    }
    // Echo the ORIGINAL choice text (not the display label which may be
    // numbered/shortened) so scrollback shows what the operator actually chose.
    // Type-guard filter: values[i] was already verified non-undefined above,
    // but the filter makes this safe against future edits that drop the guard.
    const originals = values.filter((v): v is string => v !== undefined);
    const echoLabel = originals.map((s) => sanitizeSchemaString(s, 128)).join(', ');
    writer.line(palette.dim('  ✓ ') + palette.brand(echoLabel));

    if (qType === 'choice') {
      return { action: 'accept', content: { value: originals[0] } };
    }
    return { action: 'accept', content: { value: originals } };
  }

  // Confirm-as-picker: reuse the arrow-key picker with a Yes / No
  // two-option list. Same overlay-frame vanish behaviour as choice;
  // the default value (Y/n vs y/N) controls which option starts
  // highlighted. Falls back to readLine y/n below when pickFromList
  // is absent (non-TTY surfaces).
  if (qType === 'confirm' && pickFromList) {
    const yesFirst = request.questionDefault !== false;
    const options = yesFirst ? ['Yes', 'No'] : ['No', 'Yes'];
    spillToScrollback();
    let selected: readonly string[] | null;
    try {
      selected = await pickFromList({
        header: layout.header,
        options,
        multi: false,
        signal,
      });
    } catch (err) {
      debugLog('[elicitation] confirm pickFromList failed:', err);
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
    spillToScrollback();
    const result = await runOverlayTextOrNumber(qType, request, layout.header, readTextOverlay, signal);
    if (result === null) return CANCEL;
    if (result.tag === 'skip') return SKIP;

    const echo = result.tag === 'text'
      ? sanitizeSchemaString(result.value, 256)
      : String(result.value);
    writer.line(palette.dim('  ✓ ') + palette.brand(echo));
    // result.value is a plain accessor here — both remaining union members
    // (`text` and `number`; `skip` already returned above) carry a `value`
    // property, so there is no type-narrowing reason to branch on `.tag`
    // like the `echo` computation above does (that branch calls a
    // DIFFERENT function per arm — sanitizeSchemaString vs String).
    return {
      action: 'accept',
      content: { value: result.value },
    };
  }

  // Non-overlay fallback paths: question + help line stay in scrollback
  // (no overlay to absorb them). Daemon / non-TTY / unit-test surfaces
  // land here when no overlay deps were wired.
  writer.line();
  writer.line(palette.warning('💬 Agent question'));
  if (request.context) {
    writer.line(palette.dim('  context: ') + sanitizeTerminalText(request.context));
  }
  writer.line(palette.bold('  ' + sanitizeTerminalText(request.message)));
  writer.line(palette.dim('  Type :cancel to skip this question.'));
  writer.line();

  if (qType === 'confirm') {
    return renderConfirmFallback(request, readLine, writer, signal);
  }

  // Numbered-text fallback for `choice` / `multi_choice` when no
  // pickFromList is available (non-TTY surfaces and tests that don't
  // inject the picker dependency). Behaviour identical to the pre-picker
  // implementation so daemon / piped sessions keep working unchanged.
  if (qType === 'choice') {
    return renderChoiceFallback(request, readLine, writer, signal);
  }

  if (qType === 'multi_choice') {
    return renderMultiChoiceFallback(request, readLine, writer, signal);
  }

  if (qType === 'number') {
    return renderNumberFallback(request, readLine, writer, signal);
  }

  // Default: text
  return renderTextFallback(request, readLine, writer, signal);
}
