/**
 * Model identifier types.
 * @module agent/types/model-types
 */

/**
 * Supported Claude model variants.
 *
 * `opus`/`sonnet`/`haiku` (+ the `*_1m` context variants) are the legacy tier
 * aliases that resolve through the small/medium/large slots. `fable` is a
 * fixed-id alias for Claude Fable 5 (`claude-fable-5`) — Anthropic's most
 * capable widely-released model — which sits above the opus tier and resolves
 * directly to its pinned wire id rather than through a slot.
 */
export type ClaudeModel = 'opus' | 'opus_1m' | 'sonnet' | 'sonnet_1m' | 'haiku' | 'fable';

/**
 * Supported runtime model inputs. Short aliases are mapped to full Claude
 * model identifiers by `getModelId()`.
 */
export type AgentModelInput = ClaudeModel | string;
