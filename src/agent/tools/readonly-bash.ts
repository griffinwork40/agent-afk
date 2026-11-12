/** Compatibility API for read-only bash consumers. The shared analysis owns
 * classification; this default-allow heuristic is NOT a security boundary. */
import { analyzeCommand } from '../command-classifier.js';
export { tokenizedSegmentReason } from './readonly-bash.tokenizer.js';
export { PIPE_TO_SHELL_REASON } from './readonly-bash.mutation.js';

export function classifyBashCommand(command: string): { mutating: boolean; reason?: string } {
  return analyzeCommand(command).mutation;
}
