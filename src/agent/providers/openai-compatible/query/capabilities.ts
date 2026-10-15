/**
 * Static model catalog for the openai-compatible provider.
 *
 * Extracted from `query.ts` (350-code-line ceiling) — see issue #2565.
 *
 * @module agent/providers/openai-compatible/query/capabilities
 */

import type { ProviderModelInfo } from '../../../provider.js';

/** Static model list returned by `OpenAICompatibleQuery.supportedModels()`. */
export const OPENAI_COMPATIBLE_MODELS: ProviderModelInfo[] = [
  { value: 'gpt-5.6', displayName: 'GPT-5.6 (Sol)', description: 'OpenAI flagship — alias for gpt-5.6-sol' },
  { value: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol', description: 'Frontier capability' },
  { value: 'gpt-5.6-terra', displayName: 'GPT-5.6 Terra', description: 'Balanced intelligence/cost' },
  { value: 'gpt-5.6-luna', displayName: 'GPT-5.6 Luna', description: 'Fast, high-volume workloads' },
  { value: 'gpt-5.5', displayName: 'GPT-5.5', description: 'Prior flagship (ChatGPT backend)' },
  { value: 'gpt-4o', displayName: 'GPT-4o', description: 'OpenAI flagship multimodal' },
  { value: 'gpt-4o-mini', displayName: 'GPT-4o mini', description: 'Fast/cheap GPT-4o' },
  { value: 'gpt-4.1', displayName: 'GPT-4.1', description: 'Long-context GPT-4' },
  { value: 'gpt-4.1-mini', displayName: 'GPT-4.1 mini', description: 'Fast 4.1 variant' },
  { value: 'o1', displayName: 'o1', description: 'Reasoning model' },
  { value: 'o1-mini', displayName: 'o1 mini', description: 'Fast reasoning' },
  { value: 'o3-mini', displayName: 'o3 mini', description: 'Newer reasoning, faster' },
];
