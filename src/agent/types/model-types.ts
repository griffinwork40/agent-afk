/**
 * Model identifier types.
 * @module agent/types/model-types
 */

/** Supported Claude model variants */
export type ClaudeModel = 'opus' | 'opus_1m' | 'sonnet' | 'sonnet_1m' | 'haiku';

/**
 * Supported runtime model inputs. Short aliases are mapped to full Claude
 * model identifiers by `getModelId()`.
 */
export type AgentModelInput = ClaudeModel | string;
