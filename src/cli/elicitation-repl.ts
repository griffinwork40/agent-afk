/**
 * REPL-backed elicitation handler.
 *
 * Prompts the interactive user on stdin when an MCP server requests an
 * elicitation (OAuth URL consent or structured form fields). The handler is
 * structured as a factory so tests can inject a stubbed `readLine` and
 * `writer` in place of real stdin.
 *
 * URL mode UX:
 *   1. Print a header line naming the MCP server.
 *   2. Print the message.
 *   3. Print the clickable URL.
 *   4. Prompt "Continue? [y/N]" and wait for stdin.
 *   5. Map y → accept, n → decline, empty → cancel.
 *
 * Form mode UX:
 *   1. Print a header naming the MCP server + message.
 *   2. For each field in requestedSchema.properties, prompt in order.
 *   3. Coerce values to the declared type; re-prompt on invalid input.
 *   4. Required fields re-prompt on empty; optional fields skip on empty.
 *   5. User can type :cancel or :decline at any prompt to abort.
 *   6. If schema has no properties, fall back to a single free-text prompt.
 */

import type { ElicitationRequest, ElicitationResult } from '../agent/types/sdk-types.js';
import { renderMultiSelector, renderSelector, CUSTOM_ANSWER_SENTINEL } from './input/selectors.js';
import { ringBellIfEnabled } from './_lib/capture-mode.js';
import { sanitizeSchemaString } from './_lib/sanitize.js';
import { palette } from './palette.js';

// DoS caps for MCP-controlled schema content. A malicious server can otherwise
// send `properties` with 10k+ fields or an enum with 1M+ values; both would
// hang the REPL or allocate megabyte-class strings inside writer.line().
const MAX_FIELDS = 64;
const MAX_ENUM_VALUES = 256;
const MAX_ENUM_DISPLAY = 20;
// Keys that, if accepted as field names, would walk Object.prototype when
// `content[fieldKey] = value` runs (JSON `{"__proto__": {...}}` produces an
// own enumerable property named "__proto__"). Filter explicitly.
const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);


export interface ReplElicitationDeps {
  /** Read a single line from the user. Returns the trimmed input string. */
  readLine: (prompt: string) => Promise<string>;
  /** Line writer — defaults to console.log elsewhere; tests inject captures. */
  writer: { line: (text?: string) => void };
  /** Returns the number of agent questions currently pending in the router queue. */
  pendingCount: () => number;
  /**
   * Called immediately before `readLine` is awaited. Should temporarily
   * release stdin raw-mode and the compositor keypress listener so the
   * readline interface can receive keystrokes without competition.
   * Optional — when absent the suspend/resume is a no-op (non-TTY, tests).
   */
  suspendInput?: () => void;
  /**
   * Called immediately after `readLine` resolves or rejects, before the
   * return value is processed. Should restore raw-mode and the compositor
   * keypress listener. Optional — when absent is a no-op.
   */
  resumeInput?: () => void;
  /**
   * Arrow-key picker for `choice` / `multi_choice` agent questions. Resolves
   * with the selected option(s) or `null` if the user cancels/aborts. When
   * absent (non-TTY surfaces, daemon, tests that don't exercise picker
   * UX), the handler falls back to a numbered-text prompt via `readLine`.
   *
   * The `header` array is rendered INSIDE the picker frame — meaning the
   * question prompt and option list disappear from the terminal as soon
   * as the user confirms or cancels. Only the single-line result echo
   * (committed via `writer.line` after the picker exits) survives in
   * scrollback. Mirrors inquirer.js conventions.
   */
  pickFromList?: (opts: {
    header: readonly string[];
    options: readonly string[];
    multi?: boolean;
    signal: AbortSignal;
  }) => Promise<readonly string[] | null>;
  /**
   * Text-input overlay for `text` / `number` agent questions. Same compositor
   * `enterPickerMode` mechanism as `pickFromList` — header + input row vanish
   * on confirm/cancel, leaving only the single-line echo in scrollback.
   *
   * `validate` is called on Enter; non-null return keeps the overlay open
   * with the error rendered below the input row. Resolves with the typed
   * string on confirm, `null` on Esc/Ctrl+C/abort.
   *
   * Optional — absent on non-TTY surfaces (daemon, pipes, tests that don't
   * exercise overlay UX). The handler falls back to the `readLine` numbered
   * path when this dep is undefined.
   */
  readTextOverlay?: (opts: {
    header: readonly string[];
    initial?: string;
    help?: string;
    validate?: (value: string) => string | null;
    signal: AbortSignal;
  }) => Promise<string | null>;
}

const DECLINE: ElicitationResult = { action: 'decline' };
const CANCEL: ElicitationResult = { action: 'cancel' };
const ACCEPT: ElicitationResult = { action: 'accept' };

// ---------------------------------------------------------------------------
// Form-mode types
// ---------------------------------------------------------------------------

interface FieldDef {
  type?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  title?: string;
}

type FieldOutcome =
  | { tag: 'value'; value: unknown }
  | { tag: 'cancel' }
  | { tag: 'decline' };

// ---------------------------------------------------------------------------
// Form-mode helpers
// ---------------------------------------------------------------------------

function parseProperties(schema: Record<string, unknown>): {
  properties: Record<string, FieldDef>;
  required: Set<string>;
  fieldsTruncated: boolean;
  originalFieldCount: number;
} {
  const rawProps = schema['properties'];
  // Build properties via own-keys iteration (NOT via cast) so prototype-chain
  // keys are never copied across. Bracket-write to a fresh empty object so
  // even an own enumerable "__proto__" key on rawProps lands as a normal
  // string-keyed property here rather than mutating Object.prototype.
  const properties: Record<string, FieldDef> = {};
  let originalFieldCount = 0;
  let fieldsTruncated = false;
  if (typeof rawProps === 'object' && rawProps !== null) {
    let count = 0;
    for (const [key, value] of Object.entries(rawProps as Record<string, unknown>)) {
      if (BLOCKED_KEYS.has(key)) continue; // prototype-pollution guard
      // M-5: count the original (non-blocked) field count even past the cap so
      // we can name it in the truncation warning.
      originalFieldCount += 1;
      if (count >= MAX_FIELDS) {
        fieldsTruncated = true;
        continue; // DoS cap — count remaining but do not store
      }
      // FieldDef shape is structurally typed; runtime values are coerced
      // again at promptField. The cast here narrows the iteration type only.
      properties[key] = value as FieldDef;
      count += 1;
    }
  }

  const rawRequired = schema['required'];
  const required = new Set<string>(
    Array.isArray(rawRequired)
      ? (rawRequired as unknown[])
          // M-4 DoS cap — mirrors the MAX_FIELDS guard above with headroom for
          // sparse-required schemas. Without this, a 1M-element required array
          // costs ~38ms of allocation per elicitation.
          .slice(0, MAX_FIELDS * 2)
          .filter((x): x is string => typeof x === 'string')
          .filter((x) => !BLOCKED_KEYS.has(x))
      : [],
  );

  return { properties, required, fieldsTruncated, originalFieldCount };
}

function renderFormHeader(
  writer: ReplElicitationDeps['writer'],
  req: ElicitationRequest,
): void {
  // Sanitise envelope strings — serverName, message, elicitationId are all
  // MCP-controlled and flow directly into terminal output. H-1.
  writer.line();
  writer.line(palette.warning('⚠ MCP form elicitation'));
  writer.line(palette.dim('  server:  ') + palette.bold(sanitizeSchemaString(req.serverName, 64)));
  writer.line(palette.dim('  message: ') + sanitizeSchemaString(req.message, 256));
  if (req.elicitationId) {
    writer.line(palette.dim('  id:      ') + sanitizeSchemaString(req.elicitationId, 64));
  }
  writer.line(palette.dim('  Type :decline or :cancel at any prompt to exit.'));
  writer.line();
}

/** Sentinel option appended to OPTIONAL enum/boolean pickers so the selector
 *  can express "leave unset" — mirrors the typed path's empty→default skip. */
const FORM_SKIP_SENTINEL = '\u2014 skip (optional) \u2014';

/**
 * Render an `enum` / `boolean` form field as an arrow-key picker — the same
 * `PickerController` overlay the `ask_question` choice path uses — instead of a
 * typed `readLine` prompt. Only reached when a `pickFromList` dep is wired
 * (TTY/REPL); the typed path in {@link promptField} remains the non-TTY /
 * daemon / test fallback.
 *
 * Returns a {@link FieldOutcome}:
 *   - `{ tag: 'value', value }` on confirm (enum values map back to their
 *     ORIGINAL typed entry so number/boolean enums preserve their type);
 *   - `{ tag: 'value', value: fieldDef.default }` when an optional field's skip
 *     sentinel is chosen (caller omits `undefined`);
 *   - `{ tag: 'cancel' }` on Esc / Ctrl+C / abort (picker resolves `null`).
 */
async function pickFormField(
  fieldDef: FieldDef,
  isRequired: boolean,
  label: string,
  displayKey: string,
  pickFromList: NonNullable<ReplElicitationDeps['pickFromList']>,
  writer: ReplElicitationDeps['writer'],
  signal: AbortSignal,
): Promise<FieldOutcome> {
  // Build the option labels + a resolver from display-string back to the
  // declared field value. Enum first (takes precedence over `type`), matching
  // the typed path's type-hint ordering.
  let baseLabels: string[];
  let resolveValue: (picked: string) => unknown;
  if (fieldDef.enum !== undefined) {
    const enumValues = fieldDef.enum.slice(0, MAX_ENUM_VALUES);
    baseLabels = enumValues.map((v) => sanitizeSchemaString(String(v), 64));
    resolveValue = (picked: string): unknown => {
      const idx = baseLabels.indexOf(picked);
      return idx >= 0 ? enumValues[idx] : picked;
    };
  } else {
    // boolean
    baseLabels = ['Yes', 'No'];
    resolveValue = (picked: string): unknown => picked === 'Yes';
  }

  const options = isRequired ? baseLabels : [...baseLabels, FORM_SKIP_SENTINEL];
  // The field label (enum `description` carries the per-choice guidance for
  // path-approval) renders INSIDE the picker frame and vanishes on confirm;
  // server + message stay in scrollback via the unchanged renderFormHeader.
  const header = [palette.bold('  ? ' + label), ''];

  let selected: readonly string[] | null;
  try {
    selected = await pickFromList({ header, options, multi: false, signal });
  } catch {
    return { tag: 'cancel' };
  }
  if (signal.aborted) return { tag: 'cancel' };
  if (selected === null) return { tag: 'cancel' };
  const picked = selected[0];
  if (picked === undefined) return { tag: 'cancel' };
  if (!isRequired && picked === FORM_SKIP_SENTINEL) {
    // Optional skip → declared default (caller omits undefined). Mirrors the
    // typed path's empty-input branch.
    return { tag: 'value', value: fieldDef.default };
  }
  // Single-line echo into scrollback (picker frame already vanished on confirm).
  writer.line(palette.dim('  \u2713 ') + palette.brand(`${displayKey}: ${sanitizeSchemaString(picked, 128)}`));
  return { tag: 'value', value: resolveValue(picked) };
}

async function promptField(
  fieldKey: string,
  fieldDef: FieldDef,
  isRequired: boolean,
  readLine: ReplElicitationDeps['readLine'],
  writer: ReplElicitationDeps['writer'],
  signal: AbortSignal,
  pickFromList?: ReplElicitationDeps['pickFromList'],
): Promise<FieldOutcome> {
  // M-3a: detect an abort fired between fields (after the previous promptField
  // resolved but before this one starts) before printing any label or blocking
  // on readLine. Without this, the user sees the next field's prompt for an
  // interaction that should already have been cancelled.
  if (signal.aborted) return { tag: 'cancel' };

  // Sanitise every MCP-controlled string before it reaches writer.line() —
  // descriptions, titles, type names, and enum values are all attacker-
  // influenced and must be ANSI-stripped before display.
  const label = sanitizeSchemaString(fieldDef.description ?? fieldDef.title ?? fieldKey);
  const fieldType = sanitizeSchemaString(fieldDef.type ?? 'string', 32);
  // fieldKey is also reflected to the terminal; sanitise for display, but
  // keep the original key for content[] assignment downstream.
  const displayKey = sanitizeSchemaString(fieldKey, 64);

  // Arrow-key selector path for enum / boolean fields when a picker is wired
  // (TTY/REPL surfaces). Routes the same PickerController overlay the
  // ask_question choice prompts use, so the path-approval prompt (a single
  // enum field) becomes a keyboard selector instead of a typed entry. Falls
  // through to the typed readLine loop below on non-TTY surfaces (daemon,
  // pipes, tests) where pickFromList is undefined.
  if (pickFromList && (fieldDef.enum !== undefined || fieldType === 'boolean')) {
    return pickFormField(fieldDef, isRequired, label, displayKey, pickFromList, writer, signal);
  }

  // Build type-hint string and emit unknown-type warning (once, before loop)
  let typeHint: string;
  if (fieldDef.enum !== undefined) {
    // Cap display to first MAX_ENUM_DISPLAY values; full enum is still used
    // for *validation*, but only the head is rendered to bound writer width.
    const sample = fieldDef.enum
      .slice(0, MAX_ENUM_DISPLAY)
      .map((v) => sanitizeSchemaString(String(v), 32))
      .join('|');
    const ellipsis = fieldDef.enum.length > MAX_ENUM_DISPLAY ? '|…' : '';
    typeHint = ` (enum: ${sample}${ellipsis})`;
  } else if (fieldType === 'boolean') {
    typeHint = ' (boolean: y/n)';
  } else if (fieldType === 'number' || fieldType === 'integer') {
    typeHint = ` (${fieldType})`;
  } else if (fieldType === 'string') {
    typeHint = ' (string)';
  } else {
    // Unknown type — warn once, then treat as string
    typeHint = ` (${fieldType} — treated as string)`;
    writer.line(
      palette.warning(`  ⚠ Unknown field type '${fieldType}' for '${displayKey}' — collecting as string.`),
    );
  }

  const optionalHint = isRequired ? '' : palette.dim(' [optional, enter to skip]');
  writer.line(palette.dim(`  [${displayKey}]`) + palette.dim(` ${label}`) + palette.dim(typeHint) + optionalHint);

  // M-5: surface the silent MAX_ENUM_VALUES truncation before the prompt loop
  // so the user knows why a legitimate-looking value at position >256 is
  // rejected. One-shot per field — never re-emit per re-prompt.
  if (fieldDef.enum !== undefined && fieldDef.enum.length > MAX_ENUM_VALUES) {
    writer.line(
      palette.warning(
        `  ⚠ Field '${displayKey}' has ${fieldDef.enum.length} enum values; only the first ${MAX_ENUM_VALUES} are valid for input.`,
      ),
    );
  }

  while (true) {
    let input: string;
    try {
      input = await readLine(palette.dim('  > '));
    } catch {
      return { tag: 'cancel' };
    }

    if (signal.aborted) return { tag: 'cancel' };

    // Trim FIRST, then check escape hatches: ` :cancel` / `:cancel ` must
    // still escape regardless of any paste-mode whitespace. The previous
    // raw-input check left those variants as values trapping required
    // fields in an unbounded loop.
    const trimmed = input.trim();
    if (trimmed === ':cancel') return { tag: 'cancel' };
    if (trimmed === ':decline') return { tag: 'decline' };

    // Empty-input handling
    if (trimmed === '') {
      if (isRequired) {
        writer.line(palette.warning('  (required — cannot be skipped)'));
        continue;
      }
      // Optional: skip field. If the server declared a default, surface it
      // explicitly in content rather than omitting the key; the downstream
      // guard `if (outcome.value !== undefined)` still omits when no default
      // was declared, preserving existing "user skipped" semantics.
      return { tag: 'value', value: fieldDef.default };
    }

    // Type coercion
    let coercedValue: unknown;

    if (fieldType === 'boolean') {
      const lower = trimmed.toLowerCase();
      if (lower === 'y' || lower === 'yes' || lower === 'true' || lower === '1') {
        coercedValue = true;
      } else if (lower === 'n' || lower === 'no' || lower === 'false' || lower === '0') {
        coercedValue = false;
      } else {
        writer.line(palette.warning(`  Invalid boolean — enter y/yes/true/1 or n/no/false/0.`));
        continue;
      }
    } else if (fieldType === 'number') {
      const n = Number(trimmed);
      if (!isFinite(n)) {
        writer.line(palette.warning(`  Invalid number — enter a numeric value.`));
        continue;
      }
      coercedValue = n;
    } else if (fieldType === 'integer') {
      const n = parseInt(trimmed, 10);
      if (!isFinite(n) || String(n) !== trimmed.replace(/\.0+$/, '')) {
        writer.line(palette.warning(`  Invalid integer — enter a whole number.`));
        continue;
      }
      coercedValue = n;
    } else {
      // string or unknown type — collect as string
      coercedValue = trimmed;
    }

    // Enum validation (post-coercion, comparing as strings). Iteration is
    // bounded by MAX_ENUM_VALUES to defang DoS via million-value enums.
    if (fieldDef.enum !== undefined) {
      const enumValues = fieldDef.enum.slice(0, MAX_ENUM_VALUES);
      let matched = false;
      for (const ev of enumValues) {
        if (String(ev) === String(coercedValue)) {
          matched = true;
          break;
        }
      }
      if (!matched) {
        // Sanitise both the user-entered value (rejected) and the valid-set
        // sample before emitting — coercedValue may be string-typed from
        // arbitrary input; enum values are MCP-controlled.
        const rejected = sanitizeSchemaString(String(coercedValue), 64);
        const sample = enumValues
          .slice(0, MAX_ENUM_DISPLAY)
          .map((v) => sanitizeSchemaString(String(v), 32))
          .join(', ');
        const ellipsis = enumValues.length > MAX_ENUM_DISPLAY ? ', …' : '';
        writer.line(
          palette.warning(
            `  '${rejected}' is not a valid choice. Valid: ${sample}${ellipsis}`,
          ),
        );
        continue;
      }
    }

    return { tag: 'value', value: coercedValue };
  }
}

// ---------------------------------------------------------------------------
// URL-mode helper
// ---------------------------------------------------------------------------

function renderUrlRequest(
  writer: ReplElicitationDeps['writer'],
  req: ElicitationRequest,
): void {
  // Sanitise envelope strings — serverName, message, url, elicitationId are
  // all MCP-controlled and flow directly into terminal output. H-1.
  writer.line();
  writer.line(palette.warning('⚠ MCP elicitation'));
  writer.line(palette.dim('  server:  ') + palette.bold(sanitizeSchemaString(req.serverName, 64)));
  writer.line(palette.dim('  message: ') + sanitizeSchemaString(req.message, 256));
  if (req.url) {
    writer.line(palette.dim('  url:     ') + palette.brand(sanitizeSchemaString(req.url, 512)));
  }
  if (req.elicitationId) {
    writer.line(palette.dim('  id:      ') + sanitizeSchemaString(req.elicitationId, 64));
  }
  writer.line();
}

// ---------------------------------------------------------------------------
// Agent-question mode
// ---------------------------------------------------------------------------

const SKIP: ElicitationResult = { action: 'skip' };

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
      const trimmed = raw.trim();
      if (trimmed === '') {
        if (allowSkip) return null;
        return 'Please enter a number (or esc to cancel).';
      }
      const n = Number(trimmed);
      if (!Number.isFinite(n)) return 'Please enter a valid number.';
      if (minVal !== undefined && n < minVal) return `Value must be \u2265 ${minVal}.`;
      if (maxVal !== undefined && n > maxVal) return `Value must be \u2264 ${maxVal}.`;
      return null;
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
    if (raw === '') {
      if (allowSkip) return null;
      return 'Please enter a response (or esc to cancel).';
    }
    if (minLen !== undefined && raw.length < minLen) {
      return `Response must be at least ${minLen} characters.`;
    }
    if (maxLen !== undefined && raw.length > maxLen) {
      return `Response must be at most ${maxLen} characters.`;
    }
    return null;
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
async function renderAgentQuestion(
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
      if (input === '' && request.allowSkip) return SKIP;
      if (input === '' && !request.allowSkip) {
        writer.line(palette.warning('  Please enter a number (or :cancel to skip).'));
        continue;
      }
      const n = Number(input);
      if (!isFinite(n)) {
        writer.line(palette.warning('  Please enter a valid number.'));
        continue;
      }
      if (minVal !== undefined && n < minVal) {
        writer.line(palette.warning(`  Value must be \u2265 ${minVal}.`));
        continue;
      }
      if (maxVal !== undefined && n > maxVal) {
        writer.line(palette.warning(`  Value must be \u2264 ${maxVal}.`));
        continue;
      }
      return { action: 'accept', content: { value: n } };
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
    if (input === '' && request.allowSkip) return SKIP;
    if (input === '') {
      writer.line(palette.warning('  Please enter a response (or type :cancel to skip).'));
      continue;
    }
    if (minLen !== undefined && input.length < minLen) {
      writer.line(palette.warning(`  Response must be at least ${minLen} characters.`));
      continue;
    }
    if (maxLen !== undefined && input.length > maxLen) {
      writer.line(palette.warning(`  Response must be at most ${maxLen} characters.`));
      continue;
    }
    return { action: 'accept', content: { value: input } };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function makeReplElicitationHandler(
  deps: ReplElicitationDeps,
): (request: ElicitationRequest, options: { signal: AbortSignal }) => Promise<ElicitationResult> {
  return async (request, { signal }) => {
    if (signal.aborted) return DECLINE;

    // Ring the terminal bell when an elicitation begins — the agent needs
    // input (AFK_BELL=1, TTY-only). No-op otherwise. Fires before the
    // suspend/agent-origin split so it covers every elicitation path.
    ringBellIfEnabled(process.stdout);

    // Invariant: suspendInput MUST wrap the ENTIRE handler — not just per-
    // readLine — because:
    //   1. `writer.line(...)` header writes (server name, message, "Type
    //      :cancel...") go to raw stdout BEFORE the first readLine. While the
    //      compositor is still active, the 80ms spinner ticker repaints over
    //      them on the next tick (see terminal-compositor.ts tickSpinner →
    //      repaint, gated on `suspended`).
    //   2. Arrow-key selectors (renderSelector / renderMultiSelector) own
    //      their own raw mode and keypress listener; while they're active,
    //      the compositor's overlay must stay quiescent.
    //   3. Number/text re-prompt loops emit warnings via writer.line between
    //      readLine calls — these would land in a contested overlay region
    //      if suspend were per-readLine only.
    // The compositor's suspendInput/resumeInput are idempotent and no-ops
    // when not armed (non-TTY surfaces, unit tests), so wrapping at the
    // outer scope is safe across all surfaces.
    deps.suspendInput?.();
    try {
      // Agent-originated ask_question requests take a dedicated path
      if (request.origin === 'agent') {
        return await renderAgentQuestion(request, deps, signal);
      }

      if (request.mode === 'form') {
        const schema = request.requestedSchema;
        const { properties, required, fieldsTruncated, originalFieldCount } =
          typeof schema === 'object' && schema !== null
            ? parseProperties(schema)
            : {
                properties: {} as Record<string, FieldDef>,
                required: new Set<string>(),
                fieldsTruncated: false,
                originalFieldCount: 0,
              };

        renderFormHeader(deps.writer, request);
        // M-5: surface the silent MAX_FIELDS truncation so a user looking at a
        // partial form can tell the schema was capped (vs. genuinely sparse).
        if (fieldsTruncated) {
          deps.writer.line(
            palette.warning(
              `  ⚠ Schema has ${originalFieldCount} fields; only the first ${MAX_FIELDS} will be prompted (server may be malformed or compromised).`,
            ),
          );
        }

        // Create content WITHOUT Object.prototype so that even if a blocked
        // key slips past parseProperties (defence-in-depth), assigning to it
        // cannot pollute the global prototype chain.
        const content: Record<string, unknown> = Object.create(null);

        if (Object.keys(properties).length === 0) {
          // Malformed / absent schema. The v1 fallback invented an undocumented
          // `response` key with `action: 'accept'`, which neither the MCP spec
          // recognises nor the v1 URL-mode contract honours. Decline instead —
          // safer, idempotent, and prompts the server to surface its error.
          deps.writer.line(
            palette.warning('  ⚠ Form schema has no usable fields — declining.'),
          );
          return DECLINE;
        }

        // Cross-validate: a required key absent from properties is unresolvable.
        // Without this guard, the accept payload would silently omit the key
        // and the server would reject the response with no client diagnostic.
        for (const key of required) {
          if (!(key in properties)) {
            deps.writer.line(
              palette.warning(
                `  ⚠ Required field '${sanitizeSchemaString(key, 64)}' has no schema entry — declining.`,
              ),
            );
            return DECLINE;
          }
        }

        for (const [fieldKey, fieldDef] of Object.entries(properties)) {
          // M-3b: catch abort fired in the microtask gap between iterations
          // before re-entering promptField — defence-in-depth with the inner
          // top-of-function check.
          if (signal.aborted) return CANCEL;
          const outcome = await promptField(
            fieldKey,
            fieldDef,
            required.has(fieldKey),
            deps.readLine,
            deps.writer,
            signal,
            deps.pickFromList,
          );
          if (outcome.tag === 'cancel') return CANCEL;
          if (outcome.tag === 'decline') return DECLINE;
          if (outcome.value !== undefined && !BLOCKED_KEYS.has(fieldKey)) {
            content[fieldKey] = outcome.value;
          }
        }

        // Strip the null prototype before returning so downstream JSON
        // serialisation and consumers expecting a normal POJO behave correctly.
        return { action: 'accept', content: { ...content } };
      }

      // URL mode (also the default when mode is omitted — most MCP OAuth
      // flows surface a URL to visit).
      renderUrlRequest(deps.writer, request);
      const reply = (await deps.readLine(palette.dim('Continue? [y/N] '))).trim().toLowerCase();
      if (reply === '') return CANCEL;
      if (reply === 'y' || reply === 'yes') return ACCEPT;
      return DECLINE;
    } finally {
      // Resume MUST fire on every exit path — including thrown errors and
      // early returns — or the compositor stays frozen and the next user
      // interaction sees a dead screen.
      deps.resumeInput?.();
    }
  };
}
