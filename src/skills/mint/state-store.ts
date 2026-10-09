/**
 * Per-session persistence for the /mint state machine.
 *
 * Mint pauses after the spec phase. Each Skill-tool invocation is independent,
 * so the structured `MintState` returned in the paused envelope would be lost
 * unless we round-trip it through the model — which doesn't happen reliably.
 * We instead pin it to the parent session id on disk; the next call resumes
 * by id rather than by re-passing the entire state.
 */

import { existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { getSessionsDir } from '../../paths.js';
import { writeJsonFile, readJsonFileLoose } from '../../utils/json-file.js';
import type { MintState } from './index.js';

function statePath(sessionId: string): string {
  return join(getSessionsDir(), sessionId, 'mint-state.json');
}

export function saveMintState(sessionId: string, state: MintState): void {
  // Atomic write: writeJsonFile uses tmp+rename (mkdirp by default).
  writeJsonFile(statePath(sessionId), state);
}

function isValidMintState(obj: unknown): obj is MintState {
  if (typeof obj !== 'object' || obj === null) return false;
  const s = obj as Record<string, unknown>;
  return (
    typeof s['currentPhase'] === 'string' &&
    typeof s['idea'] === 'string' &&
    typeof s['spec'] === 'string' &&
    typeof s['healIterations'] === 'number' &&
    Array.isArray(s['history'])
  );
}

export function loadMintState(sessionId: string): MintState | null {
  // readJsonFileLoose returns undefined for ENOENT and parse errors — treat
  // both as "no state". isValidMintState then guards the shape before return.
  const parsed = readJsonFileLoose<unknown>(statePath(sessionId));
  if (!isValidMintState(parsed)) return null;
  return parsed;
}

export function clearMintState(sessionId: string): void {
  const path = statePath(sessionId);
  if (!existsSync(path)) return;
  try {
    unlinkSync(path);
  } catch {
    // best-effort cleanup; a stale file gets overwritten on the next save
  }
}
