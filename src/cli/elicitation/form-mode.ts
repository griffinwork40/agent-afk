/**
 * Form-mode elicitation: types, schema parsing, and per-field prompting.
 *
 * History: extracted verbatim from `elicitation-repl.ts` (#367).
 *
 * Form mode UX:
 *   1. Print a header naming the MCP server + message.
 *   2. For each field in requestedSchema.properties, prompt in order.
 *   3. Coerce values to the declared type; re-prompt on invalid input.
 *   4. Required fields re-prompt on empty; optional fields skip on empty.
 *   5. User can type :cancel or :decline at any prompt to abort.
 *   6. If schema has no properties, fall back to a single free-text prompt.
 */

import type { ElicitationRequest } from '../../agent/types/sdk-types.js';
import { sanitizeSchemaString } from '../_lib/sanitize.js';
import { palette } from '../palette.js';
import type { ReplElicitationDeps } from './repl-shared.js';

// DoS caps for MCP-controlled schema content. A malicious server can otherwise
// send `properties` with 10k+ fields or an enum with 1M+ values; both would
// hang the REPL or allocate megabyte-class strings inside writer.line().
export const MAX_FIELDS = 64;
const MAX_ENUM_VALUES = 256;
const MAX_ENUM_DISPLAY = 20;
// Keys that, if accepted as field names, would walk Object.prototype when
// `content[fieldKey] = value` runs (JSON `{"__proto__": {...}}` produces an
// own enumerable property named "__proto__"). Filter explicitly.
export const BLOCKED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ---------------------------------------------------------------------------
// Form-mode types
// ---------------------------------------------------------------------------

export interface FieldDef {
  type?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  title?: string;
}

export type FieldOutcome =
  | { tag: 'value'; value: unknown }
  | { tag: 'cancel' }
  | { tag: 'decline' };

// ---------------------------------------------------------------------------
// Form-mode helpers
// ---------------------------------------------------------------------------

export function parseProperties(schema: Record<string, unknown>): {
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

export function renderFormHeader(
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

export async function promptField(
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
