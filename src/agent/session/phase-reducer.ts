/**
 * Phase reducer — pure function mapping (Phase, OutputEvent) → Phase.
 *
 * Tracks the operator-visible "what is the agent doing right now?" at a
 * coarse semantic level. Consumers (status line, dashboard) can subscribe
 * to phase transitions without knowing about individual tool invocations.
 *
 * @module agent/session/phase-reducer
 */

import { categorizeTool } from '../tool-category.js';
import type { OutputEvent, SubagentProgressMeta } from '../types.js';

/** Coarse operator-visible phase of the agent loop. */
export type Phase =
  | 'idle'
  | 'investigating'
  | 'editing'
  | 'testing'
  | 'building'
  | 'waiting_on_subagent'
  | 'risky_pending'
  | 'blocked_by_hook'
  | 'interrupted'
  | 'ready_for_review';

/**
 * Decay timeout in milliseconds.
 * After this period of inactivity the phase reverts to `idle`.
 * Applies to `ready_for_review` and `investigating` only — other phases
 * decay on an explicit event, not on wall-clock silence.
 */
const DECAY_MS = 30_000;

/**
 * Patterns that identify test-runner invocations in bash commands.
 * Substring-matched in declaration order; first match wins.
 */
const TEST_RUNNER_PATTERNS: readonly string[] = [
  'vitest',
  'jest',
  'pytest',
  'mocha',
  'go test',
  'cargo test',
  'rspec',
  'phpunit',
  'pnpm test',
  'npm test',
  'yarn test',
];

/**
 * Patterns that identify build invocations in bash commands.
 * Substring-matched in declaration order; first match wins.
 */
const BUILD_PATTERNS: readonly string[] = [
  'npm install',
  'pnpm install',
  'yarn install',
  'npm run build',
  'pnpm build',
  'yarn build',
  'tsc ',
  'tsc\n',
  'cargo build',
  'go build',
];

function isBashTestRunner(cmd: string): boolean {
  const lower = cmd.toLowerCase();
  return TEST_RUNNER_PATTERNS.some((p) => lower.includes(p));
}

function isBashBuild(cmd: string): boolean {
  return BUILD_PATTERNS.some((p) => cmd.includes(p));
}

/**
 * Compute the next phase given the current phase and a single output event.
 *
 * @param prev         - The current phase before the event arrives.
 * @param event        - The output event just emitted by the session.
 * @param meta         - Subagent routing metadata from the progress sink, if
 *                       the event was produced by a subagent.
 * @param now          - Current wall-clock timestamp (ms since epoch). Pass
 *                       `Date.now()` in production; inject a fixed value in
 *                       tests for determinism.
 * @param lastEventAt  - Wall-clock timestamp of the previous event. Used for
 *                       decay transitions in `ready_for_review` and
 *                       `investigating`.
 * @returns The new phase. May equal `prev` when no transition is triggered.
 */
export function reducePhase(
  prev: Phase,
  event: OutputEvent,
  meta: SubagentProgressMeta | undefined,
  now: number,
  lastEventAt: number,
): Phase {
  // Decay transitions: long silence in stable-but-not-final phases → idle.
  // External constraint: decay is wall-clock elapsed, not event-count elapsed.
  // We check this before the event switch so a new event resets the clock
  // implicitly (the caller is responsible for updating `lastEventAt`).
  const elapsed = now - lastEventAt;
  if (elapsed >= DECAY_MS) {
    if (prev === 'ready_for_review' || prev === 'investigating') {
      return 'idle';
    }
  }

  switch (event.type) {
    case 'chunk': {
      const { chunk } = event;

      if (chunk.type === 'tool_use_detail') {
        const { toolName, toolInput } = chunk;
        const cat = categorizeTool(toolName);

        // Subagent/skill/dag dispatch → waiting_on_subagent.
        if (cat === 'subagent' || cat === 'skill' || cat === 'dag') {
          return 'waiting_on_subagent';
        }

        // Plan-mode entry → risky_pending.
        if (toolName === 'EnterPlanMode') {
          return 'risky_pending';
        }

        if (cat === 'shell') {
          // Parse the command from the JSON input string.
          // toolInput is a JSON string (per ToolUseDetailChunk shape).
          let cmd = '';
          try {
            const parsed: unknown = JSON.parse(toolInput);
            if (typeof parsed === 'object' && parsed !== null && 'command' in parsed) {
              cmd = String((parsed as Record<string, unknown>)['command'] ?? '');
            }
          } catch {
            // Malformed JSON — treat as empty command (medium fallback).
            cmd = toolInput;
          }

          if (isBashTestRunner(cmd)) return 'testing';
          if (isBashBuild(cmd)) return 'building';
          // Other shell invocations — leave phase unchanged.
          return prev;
        }

        if (cat === 'write') return 'editing';
        if (cat === 'read') return 'investigating';

        return prev;
      }

      if (chunk.type === 'tool_result') {
        // A tool result with isError true while the agent was in an
        // active-work phase → hook blocked or tool errored.
        if (
          chunk.isError === true &&
          (prev === 'editing' || prev === 'testing' || prev === 'building')
        ) {
          return 'blocked_by_hook';
        }
        return prev;
      }

      if (chunk.type === 'content' || chunk.type === 'thinking') {
        // Assistant text/thinking arriving while idle → start investigating.
        if (prev === 'idle') return 'investigating';
        return prev;
      }

      return prev;
    }

    case 'progress': {
      // Subagent progress event with a non-main subagentId → waiting.
      if (meta?.subagentId !== undefined && meta.subagentId !== '__main__') {
        return 'waiting_on_subagent';
      }
      return prev;
    }

    case 'done':
      return 'ready_for_review';

    case 'error':
      return 'interrupted';

    case 'paused':
      return 'interrupted';

    case 'resumed':
      return 'investigating';

    default:
      return prev;
  }
}
