import { resolveBaseSystemPrompt } from '../system-prompt.js';
import { loadConfig } from '../config.js';
import { assembleSystemPrompt } from '../../agent/routing-directive.js';

/** ACP is a human-driven conversation, not a one-shot machine-output command. */
export function resolveAcpPrompt(cwd: string) {
  const { prompt: basePrompt, source: systemPromptSource, overlay: operatorOverlay } = resolveBaseSystemPrompt(cwd);
  const config = loadConfig(undefined, cwd);
  const systemPrompt = assembleSystemPrompt(basePrompt, config.autoRouting?.interactive ?? true, 'repl');
  return { basePrompt, operatorOverlay, systemPrompt, systemPromptSource };
}
