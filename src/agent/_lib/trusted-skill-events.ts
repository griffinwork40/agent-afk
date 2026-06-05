/**
 * Trusted-skill event bus — thin callback-registry emitter.
 * Matches the completionWriter pattern: plain function callbacks, no EventEmitter.
 * Zero imports outside of the TrustedSkillResult type.
 */

import type { TrustedSkillResult } from '../trusted-skill-result.js';

const completionHandlers = new Set<(result: TrustedSkillResult) => void>();
const startHandlers = new Set<(skillName: string) => void>();

export function onTrustedSkillComplete(fn: (result: TrustedSkillResult) => void): void {
  completionHandlers.add(fn);
}

export function offTrustedSkillComplete(fn: (result: TrustedSkillResult) => void): void {
  completionHandlers.delete(fn);
}

export function onTrustedSkillStart(fn: (skillName: string) => void): void {
  startHandlers.add(fn);
}

export function offTrustedSkillStart(fn: (skillName: string) => void): void {
  startHandlers.delete(fn);
}

export function emitTrustedSkillComplete(result: TrustedSkillResult): void {
  for (const fn of completionHandlers) fn(result);
}

export function emitTrustedSkillStart(skillName: string): void {
  for (const fn of startHandlers) fn(skillName);
}
