/**
 * /mint skill — 8-phase state machine for end-to-end feature delivery.
 *
 * Phases:
 * 1. spec — draft specification from idea
 * 2. research — gather context
 * 3. plan — create implementation plan
 * 4. parallelize — if ≥3 files, dispatch /parallelize skill
 * 5. build — execute implementation (single-lane or wave-based)
 * 6. verify — parallel test + lint + design-review
 * 7. heal — loop /diagnose + fix up to HEAL_ITERATION_CAP iterations
 * 8. ship — summary and optional commit/PR
 *
 * Hard-pause after Phase 1 for user approval unless autoApprove=true.
 *
 * @module skills/mint
 */

import { registerSkill, type SkillExecutionContext, type SkillMetadata } from '../index.js';
import type { AgentModelInput, IAgentSession } from '../../agent/types.js';
import { runSpecPhase } from './_phases/spec.js';
import { runResearchPhase } from './_phases/research.js';
import { runPlanPhase } from './_phases/plan.js';
import {
  runParallelizeDispatch,
  type ParallelizeDispatchResult,
} from './_phases/parallelize-dispatch.js';
import { appendRoutingDecision } from '../../agent/routing-telemetry.js';
import { runBuildPhase, type BuildResult } from './_phases/build.js';
import { runVerifyPhase, type VerifyResult } from './_phases/verify.js';
import { runHealPhase } from './_phases/heal.js';
import { runShipPhase } from './_phases/ship.js';
import { clearMintState, loadMintState, saveMintState } from './state-store.js';

const HEAL_ITERATION_CAP = 2;

type MintPhase =
  | 'spec'
  | 'research'
  | 'plan'
  | 'parallelize'
  | 'build'
  | 'verify'
  | 'heal'
  | 'ship';

interface HistoryEntry {
  phase: MintPhase;
  output: string;
  timestamp: number;
}

export interface MintState {
  currentPhase: MintPhase;
  idea: string;
  spec?: string;
  research?: string;
  plan?: string;
  waveOrchestrationPlan?: unknown;
  buildResults?: BuildResult;
  verifyResults?: VerifyResult;
  healIterations: number;
  history: HistoryEntry[];
}

export type MintResult =
  | { paused: true; phase: 'spec'; spec: string; state: MintState; nextStep: string }
  | { paused: true; phase: 'heal-failed'; reason: string; state: MintState; nextStep: string }
  | { completed: true; artifact: string; state: MintState };

export interface MintInput {
  /** New feature idea. Omit when resuming via userApproved. */
  idea?: string;
  autoApprove?: boolean;
  repoPath?: string;
  /** Caller-supplied state. Optional — when absent and userApproved is true, the handler loads the last paused state for this session from disk. */
  resumeFrom?: MintState;
  userApproved?: boolean;
}

/** Matches approval signals: `--continue [approved]` or bare informal approvals (`approve`, `yes`, `lgtm`, `sure`, etc.). */
const CONTINUE_RE = /^\s*(?:--continue(?:\s+(?:approved|yes|y))?|approved?|yes|y|lgtm|sure)\s*$/i;

const RESUME_HINT =
  'To approve and run the rest of the pipeline, say "approve", "yes", "sure", or "lgtm" — or invoke /mint --continue approved. The handler will reload the spec state from disk.';

function appendHistory(state: MintState, phase: MintPhase, output: string): void {
  state.history.push({ phase, output, timestamp: Date.now() });
}

/**
 * Defense-in-depth: assert that a MintResult does not simultaneously carry
 * both `completed` and `paused` keys, which would indicate a broken return site.
 * The MintResult union type prevents this at compile time, but a runtime check
 * catches any future type-cast or `as` escape.
 */
function assertMintResultShape(result: MintResult): void {
  if ('completed' in result && 'paused' in result) {
    throw new Error(
      'mint: invariant violation — MintResult carries both completed and paused keys simultaneously',
    );
  }
}

/**
 * Truncate a free-form error string before it crosses into persisted state
 * or the routing-decisions telemetry stream. The 240-char cap matches the
 * pattern used in `subagent-executor.ts` for the same field; the privacy
 * contract is documented in `routing-telemetry.ts` §G.4.
 */
const MAX_ERROR_MESSAGE_CHARS = 240;
function truncateErrorMessage(s: string): string {
  return s.length <= MAX_ERROR_MESSAGE_CHARS
    ? s
    : s.slice(0, MAX_ERROR_MESSAGE_CHARS) + '…';
}

function parseMintInput(input: unknown): MintInput {
  if (typeof input === 'string') {
    if (CONTINUE_RE.test(input)) {
      return { userApproved: true };
    }
    // Some callers (notably the `skill` tool boundary) serialize an intended
    // structured input — e.g. `{userApproved: true}` — to a JSON string before
    // dispatch. Without this guard, that string falls through to the
    // idea-treatment branch below, the resume gate is skipped, the disk state
    // is wiped by `clearMintState`, and the spec subagent is handed an opaque
    // control-signal token to interpret as a feature idea. Recurse into the
    // object branch when the string parses as a JSON object.
    if (input.length > 1 && input.trimStart().startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(input);
        if (typeof parsed === 'object' && parsed !== null) {
          return parseMintInput(parsed);
        }
      } catch {
        // Not valid JSON — fall through to idea treatment.
      }
    }
    return { idea: input };
  }
  if (typeof input === 'object' && input !== null) {
    const obj = input as Record<string, unknown>;
    const ideaField = typeof obj['idea'] === 'string' ? (obj['idea'] as string) : undefined;
    // `idea` field carrying the continue shorthand is treated as a resume signal — the model
    // may pass the slash arguments verbatim under `idea` instead of as the raw string input.
    if (ideaField !== undefined && CONTINUE_RE.test(ideaField)) {
      return { userApproved: true };
    }
    if ('idea' in obj || 'resumeFrom' in obj || obj['userApproved'] === true) {
      return obj as MintInput;
    }
  }
  throw new Error(
    'mint handler requires input.idea (string), input as string, or {userApproved: true} to resume',
  );
}

/**
 * Run phases 2–8 on an initialized state that already has a spec.
 * Shared by the initial autoApprove path and the resumeFrom path.
 */
async function runPhasesAfterSpec(
  state: MintState,
  parentSession: IAgentSession,
  // Tool-use ID of the `skill` ToolCall that invoked the mint handler. When
  // present, each phase forwards it as `parentId` to its `forkSubagent` so
  // every forked subagent's synthesized `Agent(<label>)` row nests under the
  // mint skill's tool-lane entry in the live overlay AND in the committed
  // scrollback block. Without it, regular subagents orphan to root the
  // moment their Done block commits (raw session UUID can't be resolved to
  // a lane entry by the renderer's parentId resolver — see
  // stream-renderer.ts:262-280, and skills/index.ts SkillExecutionContext.callId).
  skillCallId?: string,
  defaultSubagentModel: AgentModelInput = 'sonnet',
  // Forwarded to the heal phase, which dispatches the agent-driven `/diagnose`
  // skill (bundled-plugin SKILL.md, context: fork). Threaded from the mint
  // handler's SkillExecutionContext (`ctx.dispatchSkill`). Optional so the
  // resume/autoApprove paths and tests without a dispatch context degrade
  // gracefully — heal then self-diagnoses from the verification issues.
  dispatchSkill?: (name: string, args?: string) => Promise<string>,
): Promise<MintResult> {
  if (!parentSession.sessionId) {
    throw new Error('runPhasesAfterSpec requires parentSession.sessionId');
  }
  const parentSessionId: string = parentSession.sessionId;
  // Threaded into every phase so forked subagents inherit the parent's
  // worktree (e.g. `afk interactive -w`). Without this, child bash/grep
  // falls back to the Node host's process.cwd() — which is shared across
  // concurrent sessions and defeats worktree isolation.
  const parentCwd = parentSession.cwd;
  try {
    state.currentPhase = 'research';
    state.research = await runResearchPhase(state.spec!, parentSessionId, parentCwd, skillCallId, defaultSubagentModel);
    appendHistory(state, 'research', state.research);

    state.currentPhase = 'plan';
    state.plan = await runPlanPhase(state.spec!, state.research, parentSessionId, parentCwd, skillCallId, defaultSubagentModel);
    appendHistory(state, 'plan', state.plan);

    state.currentPhase = 'parallelize';
    const parallelizeResult: ParallelizeDispatchResult = await runParallelizeDispatch(
      state.plan,
      parentSession,
      skillCallId,
      defaultSubagentModel,
    );
    if (parallelizeResult.kind === 'plan') {
      state.waveOrchestrationPlan = parallelizeResult.plan;
      appendHistory(state, 'parallelize', JSON.stringify(parallelizeResult.plan));
    } else if (parallelizeResult.kind === 'skipped') {
      state.waveOrchestrationPlan = undefined;
      appendHistory(state, 'parallelize', `skipped: ${parallelizeResult.reason}`);
    } else if (parallelizeResult.kind === 'failed') {
      // failed — surface the degradation. The build phase will still proceed
      // single-lane (preserving prior non-fatal behavior), but the failure is
      // now visible in (1) the persisted history entry the user can inspect,
      // (2) the existing routing-decisions telemetry stream, and (3) a
      // console.warn so an interactive operator sees the degradation inline.
      // See docs/audits/orchestration-pressure-audit.md §D / §G.
      state.waveOrchestrationPlan = undefined;
      // Truncate the error string before persistence/telemetry to honor the
      // routing-telemetry privacy contract (§G.4: "Short error message — no
      // stack traces, no user content"). The underlying `err.message` may
      // interpolate plan content from a user-installed handler.
      const truncatedError = truncateErrorMessage(parallelizeResult.error);
      appendHistory(state, 'parallelize', `failed: ${truncatedError}`);
      void appendRoutingDecision({
        event: 'fallback.inline',
        parent_session_id: parentSessionId,
        reason: 'parallelize-dispatch-failed',
        error_message: truncatedError,
      });
      // Interactive-visibility surface — silent telemetry alone leaves an
      // operator with no signal that parallelism was attempted and failed.
      console.warn(
        `[mint] parallelize dispatch failed (single-lane fallback): ${truncatedError}`,
      );
    } else {
      // Exhaustiveness guard — adding a new arm to ParallelizeDispatchResult
      // without updating this branch is a compile-time error.
      const _exhaustive: never = parallelizeResult;
      void _exhaustive;
    }

    state.currentPhase = 'build';
    state.buildResults = await runBuildPhase(
      state.plan,
      state.waveOrchestrationPlan,
      parentSessionId,
      parentCwd,
      skillCallId,
      defaultSubagentModel,
    );
    appendHistory(state, 'build', JSON.stringify(state.buildResults));

    state.currentPhase = 'verify';
    state.verifyResults = await runVerifyPhase(
      state.plan,
      state.buildResults,
      parentSessionId,
      parentCwd,
      skillCallId,
      defaultSubagentModel,
    );
    appendHistory(state, 'verify', JSON.stringify(state.verifyResults));

    // Heal loop — retry up to HEAL_ITERATION_CAP times while verify is red.
    state.currentPhase = 'heal';
    let healed =
      state.verifyResults.testsPassed &&
      state.verifyResults.lintPassed &&
      state.verifyResults.designReviewPassed;

    while (!healed && state.healIterations < HEAL_ITERATION_CAP) {
      const healResult = await runHealPhase(
        state.plan,
        state.buildResults,
        state.verifyResults,
        state.healIterations,
        parentSession,
        skillCallId,
        defaultSubagentModel,
        dispatchSkill,
      );
      state.healIterations = healResult.newHealIterations;
      state.verifyResults = healResult.newVerifyResults;
      healed = healResult.healed;
      appendHistory(
        state,
        'heal',
        `Iterations: ${state.healIterations}, Success: ${healed}`,
      );
    }

    if (!healed) {
      return {
        paused: true,
        phase: 'heal-failed',
        reason: `Heal capped at ${state.healIterations} iterations; still have failures`,
        state,
        nextStep:
          'Heal loop exhausted. Inspect verifyResults, fix manually, then re-invoke /mint with a fresh idea — resume is not supported from heal-failed.',
      };
    }

    state.currentPhase = 'ship';
    const artifact = await runShipPhase(state, parentSessionId, parentCwd, skillCallId, defaultSubagentModel);
    appendHistory(state, 'ship', artifact);

    return { completed: true, artifact, state };
  } catch (err) {
    throw new Error(`mint failed at ${state.currentPhase}: ${err}`);
  }
}

/**
 * Forward a `runPhasesAfterSpec` outcome through state-store cleanup and return it.
 * Completed or heal-failed are both terminal for the on-disk state.
 */
function finalizeAfterSpec(sessionId: string, result: MintResult): MintResult {
  assertMintResultShape(result);
  if ('completed' in result || result.phase === 'heal-failed') {
    clearMintState(sessionId);
  }
  return result;
}

async function handler(
  input: unknown,
  parentSession?: IAgentSession,
  ctx?: SkillExecutionContext,
): Promise<MintResult> {
  const mintInput = parseMintInput(input);

  if (!parentSession?.sessionId) {
    throw new Error('mint handler requires a parent session to fork subagents');
  }
  const parentSessionId = parentSession.sessionId;
  // Tool-use ID of the `skill` ToolCall that invoked this handler. Threaded
  // into every phase so forked subagents nest under the mint skill's
  // tool-lane entry in both the live overlay and the committed scrollback
  // block. See skills/index.ts SkillExecutionContext.callId.
  const skillCallId = ctx?.callId;
  const defaultSubagentModel = ctx?.defaultSubagentModel ?? ctx?.defaultModel ?? 'sonnet';

  // Resume path — caller-supplied resumeFrom wins; otherwise reload the last
  // paused state for this session from disk.
  if (mintInput.userApproved) {
    const resumeState = mintInput.resumeFrom ?? loadMintState(parentSessionId);
    if (!resumeState) {
      throw new Error(
        'mint: no paused spec found for this session to continue. Run /mint <idea> first, then /mint --continue approved.',
      );
    }
    const result = await runPhasesAfterSpec(resumeState, parentSession, skillCallId, defaultSubagentModel, ctx?.dispatchSkill);
    return finalizeAfterSpec(parentSessionId, result);
  }

  if (!mintInput.idea) {
    throw new Error(
      'mint: no idea provided. Run /mint <idea> to start, or /mint --continue approved to resume a paused spec.',
    );
  }

  // Fresh idea — drop any stale paused state from a prior run on this session.
  clearMintState(parentSessionId);

  const state: MintState = {
    currentPhase: 'spec',
    idea: mintInput.idea,
    healIterations: 0,
    history: [],
  };

  try {
    state.spec = await runSpecPhase(mintInput.idea, parentSessionId, parentSession.cwd, skillCallId, defaultSubagentModel);
    appendHistory(state, 'spec', state.spec);
  } catch (err) {
    throw new Error(`mint failed at spec: ${err}`);
  }

  if (!mintInput.autoApprove) {
    saveMintState(parentSessionId, state);
    const pausedResult: MintResult = {
      paused: true,
      phase: 'spec',
      spec: state.spec,
      state,
      nextStep: RESUME_HINT,
    };
    assertMintResultShape(pausedResult);
    return pausedResult;
  }

  const result = await runPhasesAfterSpec(state, parentSession, skillCallId, defaultSubagentModel, ctx?.dispatchSkill);
  return finalizeAfterSpec(parentSessionId, result);
}

const mintSkill: SkillMetadata = {
  name: 'mint',
  description:
    'Takes a feature idea or refactor scope and delivers a ship-ready, verified implementation end-to-end',
  handler,
  argumentHint: '<idea> | --continue [approved]',
  whenToUse:
    'When the user wants a feature or refactor delivered end-to-end (spec → research → build → verify) in one ship-ready pass. After the spec phase pauses for approval, resume by invoking mint again with the literal string `"approved"` (or `"yes"`, `"lgtm"`, `"--continue approved"`) as the arguments. Equivalent JSON forms `{"userApproved": true}` and `{"idea": "approved"}` are also accepted. The handler reloads the spec state from disk and runs phases 2–8.',
  flags: ['--continue'],
};

registerSkill(mintSkill);

export { mintSkill };
