import type { AgentModelInput } from '../agent/types.js';

const SAFE_SHELL_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

export function shellQuoteToken(value: string): string {
  if (SAFE_SHELL_TOKEN.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function formatResumeCommand(target: string, model?: AgentModelInput): string {
  const parts = ['afk', 'interactive'];
  if (typeof model === 'string' && model.length > 0) {
    parts.push('--model', shellQuoteToken(model));
  }
  parts.push('--resume', shellQuoteToken(target));
  return parts.join(' ');
}
