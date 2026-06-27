/**
 * In-process custom tool registration helper — SDK parity with `tool()`.
 *
 * Lets library consumers register typed, Zod-validated tools without
 * replacing the entire ToolDispatcher. Custom tools flow through the normal
 * dispatch path (PreToolUse/PostToolUse hooks fire, permission gate applies).
 *
 * @module agent/tools/custom-tool
 */

import { z } from 'zod';
import type { AnthropicToolDef, ToolHandler, ToolHandlerContext } from './types.js';

/** A fully-specified custom tool ready for registration on a provider. */
export interface CustomToolDef {
  /** Anthropic-compatible schema (name, description, input_schema). */
  schema: AnthropicToolDef;
  /** Handler that receives the parsed/validated input and returns a ToolResult. */
  handler: ToolHandler;
}

/**
 * Build a {@link CustomToolDef} from a name, description, Zod schema, and
 * handler function.
 *
 * The produced handler wraps the user-supplied `handler`:
 *   1. Parses `input` through the Zod schema (safe parse — never throws).
 *   2. On validation failure, returns `{ isError: true, content: [...] }`.
 *   3. On success, forwards the typed, parsed value to the user handler.
 *
 * The `input_schema` field of the returned `AnthropicToolDef` is derived via
 * `z.toJSONSchema(schema)` (Zod v4.3.6+).
 *
 * @example
 * ```ts
 * const greet = tool(
 *   'greet',
 *   'Greet a user by name',
 *   z.object({ name: z.string() }),
 *   async ({ name }) => ({ content: `Hello, ${name}!` }),
 * );
 * ```
 */
export function tool<S extends z.ZodType>(
  name: string,
  description: string,
  schema: S,
  handler: (input: z.infer<S>, signal: AbortSignal, context?: ToolHandlerContext) => ReturnType<ToolHandler>,
): CustomToolDef {
  // Derive the JSON Schema from the Zod schema.  z.toJSONSchema() is
  // available in Zod v4.3.6+ and returns a plain object whose shape is a
  // superset of the AnthropicToolDef.input_schema contract.
  const jsonSchema = z.toJSONSchema(schema) as Record<string, unknown>;

  // Normalise to the required `{ type: 'object', ... }` shape.  Most Zod
  // object schemas already produce `{ type: 'object', properties: … }`;
  // we force the `type` field to satisfy the AnthropicToolDef constraint.
  const input_schema: AnthropicToolDef['input_schema'] = {
    type: 'object' as const,
    ...jsonSchema,
  };

  const toolSchema: AnthropicToolDef = {
    name,
    description,
    input_schema,
  };

  // Contract: the wrapped handler validates input with the Zod schema before
  // forwarding to the user handler. Validation failures return a structured
  // error result — they do NOT throw — so the dispatcher's catch clause is
  // never the first line of defence for user-schema mismatches.
  const wrappedHandler: ToolHandler = async (
    input: unknown,
    signal: AbortSignal,
    context?: ToolHandlerContext,
  ) => {
    const result = schema.safeParse(input);
    if (!result.success) {
      const message = result.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ');
      return {
        isError: true,
        content: `Tool input validation failed for "${name}": ${message}`,
      };
    }
    return handler(result.data as z.infer<S>, signal, context);
  };

  return { schema: toolSchema, handler: wrappedHandler };
}
