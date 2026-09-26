/**
 * Public barrel for the what-if prediction engine.
 *
 * Consumers (`src/cli/commands/whatif.ts`, `src/cli/slash/commands/whatif.ts`)
 * import everything from this module.
 *
 * @module whatif
 */

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export { runWhatif, WhatifBudgetError } from './run.js';

// ---------------------------------------------------------------------------
// Level 0 — Structural
// ---------------------------------------------------------------------------

export { computeStructuralImpact } from './structural.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  Change,
  ChangeKind,
  ChangeSpec,
  LaunchSettings,
  Environment,
  OperatorContext,
  ChangeOperator,
  RequestSnapshot,
  StructuralImpact,
  PredictionDirection,
  Confidence,
  Prediction,
  Episode,
  ToolRequest,
  EpisodeTrace,
  RunnerOptions,
  AgentRunner,
  EpisodeFeatures,
  JudgeQuestion,
  JudgeInput,
  JudgeResult,
  Judge,
  RateComparison,
  Verdict,
  VerifiedPrediction,
  DiscoveredDifference,
  FeatureDelta,
  VerifyResult,
  WhatifReport,
  WhatifStage,
  WhatifProgress,
  CompleteFn,
  WhatifOptions,
  WhatifDeps,
} from './types.js';

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

export { renderTerminal, renderMarkdown } from './report.js';

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export { createAfkRunner } from './runner/afk-runner.js';

// ---------------------------------------------------------------------------
// CompleteFn factory
// ---------------------------------------------------------------------------

export { createAnthropicComplete } from './complete.js';

// ---------------------------------------------------------------------------
// Judge
// ---------------------------------------------------------------------------

export { resolveJudge } from './judge/index.js';
export { connectJev } from './judge/jev-connect.js';
export { createClaudeJudge } from './judge/claude.js';

// ---------------------------------------------------------------------------
// Compiler
// ---------------------------------------------------------------------------

export { compileChangeSpec } from './compile.js';

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

export { describeChange } from './operators/index.js';
