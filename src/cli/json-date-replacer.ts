/**
 * Shared `JSON.stringify` replacer for NDJSON/SSE wire output.
 *
 * Extracted from `chat.ts`'s `--format stream-json` path so the same
 * Date/Error handling is available to other JSON-over-the-wire producers
 * (the `afk web` SSE server) without duplicating it.
 *
 * @module cli/json-date-replacer
 */

/**
 * Replacer: `Date` instances (e.g. `paused.resetsAt`) would serialize as `{}`
 * without this — convert them to ISO-8601 strings instead. `Error` instances
 * are reduced to `{ message, name }`; a V8 stack trace embeds absolute
 * filesystem paths and would leak host-machine layout to a remote consumer.
 */
export function jsonDateReplacer(_k: string, v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Error) return { message: v.message, name: v.name };
  return v;
}
