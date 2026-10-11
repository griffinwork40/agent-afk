/**
 * Shared plain-object type guards.
 *
 * Two variants exist because callers disagree on whether arrays are "records":
 *
 * - {@link isPlainObject} — the strict guard: arrays are **not** plain objects.
 *   Use when you need `{ key: value }` objects and want to reject `[]`.
 *
 * - {@link isRecord} — the permissive guard: arrays **are** included.
 *   Kept for the web-server route parsing code that historically accepted
 *   arrays and must continue to do so for backwards-compat.
 *
 * @module utils/type-guards
 */

/**
 * Returns `true` iff `v` is a non-null object that is **not** an array.
 *
 * Replaces the inline `typeof v === 'object' && v !== null && !Array.isArray(v)`
 * pattern used in journal/records, skills/score, and 20+ other sites.
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Returns `true` iff `v` is a non-null object (arrays included).
 *
 * This is the permissive variant used by the web-server route parsers.
 * JSON.parse can return an array at the top level, and the HTTP routes were
 * written to handle that gracefully by checking field presence on the parsed
 * value (which works on both objects and arrays).
 */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Exhaustiveness checker for discriminated unions.
 *
 * Call in the `default` branch of a `switch` (or the final `else` of an
 * `if`/`else-if` chain) to get a compile-time error when a new variant is
 * added but not handled.
 *
 * @example
 * ```ts
 * switch (shape.kind) {
 *   case 'circle': ...
 *   case 'rect': ...
 *   default: assertNever(shape);
 * }
 * ```
 */
export function assertNever(x: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(x)}`);
}
