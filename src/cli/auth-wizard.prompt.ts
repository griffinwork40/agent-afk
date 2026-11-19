import { promptSecret } from '../utils/prompt-secret.js';

/** Arm no-echo before the shared reader writes its prompt, not after it. */
export function promptAuthSecret(question: string): Promise<string> {
  // External constraint: a fast paste can arrive as soon as the prompt is
  // visible. The shared reader writes it before setting raw mode, so disable
  // echo first for sign-in, including confirmation prompts that might get a key.
  if (process.stdin.isTTY) process.stdin.setRawMode?.(true);
  return promptSecret(question);
}
