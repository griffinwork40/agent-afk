/**
 * Outbound request shaping for one round of the anthropic-direct turn loop.
 *
 * Currently owns the wire projection of tool definitions; the cache-breakpoint
 * stamp, params assembly, and the `messages.create` retry wrapper join it as
 * the loop split proceeds.
 *
 * @module agent/providers/anthropic-direct/loop/round-request
 */

import type { AnthropicToolDef, WireToolDef } from '../types.js';

/**
 * Contract: project an internal {@link AnthropicToolDef} to the wire-safe shape
 * the Anthropic Messages API actually accepts.
 *
 * Strips internal classification metadata (`category`, `concurrencySafe`,
 * `riskClass`) that would otherwise trip a 400
 * `tools.0.custom.<field>: Extra inputs are not permitted` on `messages.create`.
 *
 * The wire boundary type (`AnthropicMessagesCreateParams.tools: WireToolDef[]`)
 * forces every call site to go through a projection like this one — keep it
 * that way.
 */
export function toWireTool(tool: AnthropicToolDef): WireToolDef {
  const { name, description, input_schema } = tool;
  return {
    name,
    ...(description !== undefined ? { description } : {}),
    input_schema,
  };
}
