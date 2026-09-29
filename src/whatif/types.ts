/**
 * Shared contract for the what-if prediction engine.
 *
 * Contract: every module under `src/whatif/` communicates only through the
 * types declared here. The engine depends on two seams, {@link ChangeOperator}
 * (how a change transforms an environment) and {@link AgentRunner} (how an
 * episode is executed in an environment), so a non-agent-afk agent can be
 * supported by supplying a different runner without touching the engine.
 *
 * Design record: `docs/whatif-design.md`. User guide: `docs/whatif.md`.
 *
 * @module whatif/types
 */

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

/**
 * One atomic change to the agent's environment. A {@link ChangeSpec} is an
 * ordered list of these, applied to the candidate sandbox only.
 *
 * Paths in `file` are either `home:<rel>` (relative to AFK_HOME, e.g.
 * `home:AFK.md`, `home:state/memory/HOT.md`) or `project:<rel>` (relative to
 * the project cwd, e.g. `project:AFK.md`).
 */
export type Change =
  | { kind: 'append'; target: 'user-afk-md' | 'project-afk-md'; text: string }
  | { kind: 'file'; path: string; content: string }
  | { kind: 'hot'; content: string }
  | { kind: 'memory-add'; content: string; category: 'preference' | 'convention' | 'decision' | 'learning' }
  | { kind: 'memory-remove'; id: number }
  | { kind: 'disable-skill'; name: string }
  | { kind: 'disable-plugin'; name: string }
  | { kind: 'model'; model: string }
  | { kind: 'effort'; effort: string }
  | { kind: 'env'; key: string; value: string };

export type ChangeKind = Change['kind'];

export interface ChangeSpec {
  /** One-line human description, e.g. "Append an always-ask rule to AFK.md". */
  title: string;
  changes: Change[];
}

/** Launch settings for an episode subprocess (model, effort, extra env). */
export interface LaunchSettings {
  model?: string;
  effort?: string;
  /** Extra env vars for the child. Never contains credentials. */
  env: Record<string, string>;
  /**
   * Env keys the child must NOT inherit from the parent process, so it
   * re-reads them from the sandbox's own `config/afk.env`. dotenv never
   * overrides an existing variable, so without this a parent that already
   * loaded the real afk.env would shadow a candidate edit to that file.
   */
  unset?: string[];
}

/**
 * A materialized, isolated environment. Created by the sandbox materializer,
 * mutated by operators (candidate only), consumed by the runner.
 */
export interface Environment {
  /** 'baseline' or 'candidate'. */
  label: 'baseline' | 'candidate';
  /** Absolute sandbox AFK_HOME. State lives at `<home>/state`. */
  home: string;
  /** Absolute project cwd the agent runs in (real cwd or a temp worktree). */
  cwd: string;
  launch: LaunchSettings;
}

/** Context handed to operators so they can resolve real paths. */
export interface OperatorContext {
  /** The real AFK_HOME (read-only source). */
  realHome: string;
  /** The real project cwd (read-only source). */
  realCwd: string;
}

/**
 * Applies one change kind to a candidate environment. Must only ever write
 * inside `env.home` or `env.cwd` (which the materializer guarantees are
 * sandbox copies), never the real tree.
 */
export interface ChangeOperator<K extends ChangeKind = ChangeKind> {
  kind: K;
  /** True when the change needs the project tree isolated (temp worktree). */
  touchesProject(change: Extract<Change, { kind: K }>): boolean;
  /** Relative home paths that must be real copies (not symlinks) before apply. */
  homePathsToCopy(change: Extract<Change, { kind: K }>): string[];
  apply(change: Extract<Change, { kind: K }>, env: Environment, ctx: OperatorContext): Promise<void>;
  /** Plain-English one-liner for reports. */
  describe(change: Extract<Change, { kind: K }>): string;
}

// ---------------------------------------------------------------------------
// Level 0: structural snapshot
// ---------------------------------------------------------------------------

/** The exact request the model would receive for a probe turn. */
export interface RequestSnapshot {
  model: string;
  system: string;
  tools: { name: string; description: string }[];
  /** Text of the first user message as sent (after hook injections). */
  firstUserMessage: string;
}

export interface StructuralImpact {
  baseline: RequestSnapshot;
  candidate: RequestSnapshot;
  /** Unified-style line diff of the system prompt ('' when identical). */
  systemDiff: string;
  toolsAdded: string[];
  toolsRemoved: string[];
  toolsChanged: string[];
  /** Diff of the first user message (hook / preamble injections). */
  userMessageDiff: string;
  /** Estimated system+tools tokens, baseline and candidate. */
  tokens: { baseline: number; candidate: number };
  /** Estimated input-cost delta per turn in USD (undefined if model unpriced). */
  perTurnCostDeltaUsd?: number;
  modelChanged: boolean;
}

// ---------------------------------------------------------------------------
// Level 1: predictions
// ---------------------------------------------------------------------------

export type PredictionDirection = 'added' | 'removed' | 'strengthened' | 'weakened';
export type Confidence = 'high' | 'medium' | 'low';

/**
 * Whether a prediction can be measured by a decision-only episode (#2409),
 * decided at predict time, before any data exists.
 *
 * - `'decision'`: what the agent chooses, says, requests or proposes in its
 *   turn, up to and including its first side-effecting request (which the
 *   episode gate records as intent). Scored normally.
 * - `'downstream'`: needs an intercepted action to COMPLETE, or its results
 *   (tests pass, file content is correct, a subagent finds the bug, total task
 *   cost, behavior after verification). Always verdict `'unobservable'`.
 */
export type PredictionObservable = 'decision' | 'downstream';

export interface Prediction {
  /** Stable id within a run, e.g. "p1". */
  id: string;
  /** Plain English, e.g. "Asks a clarifying question before using tools". */
  behavior: string;
  direction: PredictionDirection;
  confidence: Confidence;
  reason: string;
  /**
   * Positively framed yes/no question answerable from ONE episode output, e.g.
   * "Does the response ask the user a clarifying question before using any tool?"
   * The measured rate is P(yes) across this prediction's own probes (#2403).
   */
  testQuestion: string;
  /** 1-2 synthetic user requests likely to exercise this behavior. */
  probes: string[];
  /**
   * Predict-time observability tag (#2409). `predictChanges` always sets it;
   * absent (older results, hand-built fixtures) means `'decision'`.
   */
  observable?: PredictionObservable;
  /** One short line on why the behavior is `'downstream'`. Optional. */
  observabilityReason?: string;
  /**
   * Analyst's honest estimate of the baseline P(yes) on these probes, in
   * [0, 1].  Optional — absent means no headroom check is applied (#2504).
   *
   * For `added`/`strengthened` predictions, low values (near 0) mean good
   * headroom for an increase.  For `removed`/`weakened`, high values (near 1)
   * mean good headroom for a decrease.
   */
  baselineEstimate?: number;
}

// ---------------------------------------------------------------------------
// Level 2: episodes
// ---------------------------------------------------------------------------

export interface Episode {
  id: string;
  source: 'real' | 'synthetic' | 'suite';
  /** User request text (preambles stripped, secrets redacted for real turns). */
  prompt: string;
  /** Prediction id a synthetic probe targets. */
  targets?: string;
}

/** One tool request observed during an episode (from the episode gate log). */
export interface ToolRequest {
  tool: string;
  input: unknown;
  /** 'executed' = read-only, allowed; 'recorded' = side effect, blocked. */
  verdict: 'executed' | 'recorded';
}

export interface EpisodeTrace {
  episodeId: string;
  env: 'baseline' | 'candidate';
  sample: number;
  /** Final assistant text. */
  text: string;
  tools: ToolRequest[];
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
  /** Set when the episode failed to run (subprocess error, timeout). */
  error?: string;
}

export interface RunnerOptions {
  /** Hard wall-clock cap per episode. */
  timeoutMs: number;
  /** Max conversation turns passed to the agent. */
  maxTurns: number;
  signal?: AbortSignal;
}

/** Executes a single episode in an environment. */
export interface AgentRunner {
  name: string;
  run(env: Environment, episode: Episode, sample: number, opts: RunnerOptions): Promise<EpisodeTrace>;
  /** Capture the exact model request for a probe prompt, without a real model call. */
  snapshot(env: Environment, probePrompt: string, opts: RunnerOptions): Promise<RequestSnapshot>;
}

// ---------------------------------------------------------------------------
// Observation and judging
// ---------------------------------------------------------------------------

/** Deterministic features computed from one trace, no model calls. */
export interface EpisodeFeatures {
  firstAction: 'answer' | 'read' | 'side-effect' | 'ask' | 'delegate' | 'none';
  askedBeforeActing: boolean;
  delegated: boolean;
  usedTools: string[];
  usedSkills: string[];
  searchedMemory: boolean;
  toolCalls: number;
  responseChars: number;
  errored: boolean;
}

/** A question to grade on every output (prediction test or discovered difference). */
export interface JudgeQuestion {
  id: string;
  question: string;
}

export interface JudgeInput {
  /** The user request the episode answered. */
  prompt: string;
  /** Rendered output: assistant text plus a compact tool-request list. */
  output: string;
  questions: JudgeQuestion[];
}

/** P(yes) per question id, in [0,1]. */
export type JudgeResult = Record<string, number>;

export interface Judge {
  name: 'jev' | 'claude';
  /** True when the judge sends content to a third party outside Anthropic. */
  external: boolean;
  grade(input: JudgeInput, signal?: AbortSignal): Promise<JudgeResult>;
  close?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Statistics and report
// ---------------------------------------------------------------------------

export interface RateComparison {
  baseline: number;
  candidate: number;
  /** candidate - baseline. */
  delta: number;
  /** 95% interval on delta. */
  ci: [number, number];
  n: { baseline: number; candidate: number };
}

export type Verdict = 'confirmed' | 'refuted' | 'unclear' | 'unobservable';

/**
 * Which episodes back one prediction's verdict (issue #2403). A prediction is
 * scored only on its own synthetic probes (`Episode.targets`); every other
 * episode is reported as `background`, never pooled into the verdict.
 */
export interface PredictionScope {
  /** Episode ids with at least one graded output in each arm, in run order. */
  episodes: { baseline: string[]; candidate: string[] };
  /** Episodes written to target this prediction (before failures/judging). */
  targetedEpisodes: number;
  /**
   * Total graded sample observations across both arms (#2404).
   * `rates.n` reports unique episodes; this shows how many individual
   * samples fed into those episode means. Absent in pre-#2404 results.
   */
  totalSamples?: number;
  /**
   * The same question graded on every non-targeted episode. Context only:
   * shows whether the behavior shifted outside its probes. Absent when an
   * arm had no graded non-targeted output.
   */
  background?: RateComparison;
}

export interface VerifiedPrediction {
  prediction: Prediction;
  /** Rates over the prediction's targeted episodes only; drives `verdict`. */
  rates: RateComparison;
  verdict: Verdict;
  /** Absent in results written before #2403 (those pooled every episode). */
  scope?: PredictionScope;
  /**
   * Why the verdict is `'unobservable'`: the prediction was tagged
   * `observable: 'downstream'` at predict time. Optional, additive.
   */
  unobservableReason?: string;
  /**
   * Per-prediction cross-check agreement rate (#2413): fraction of cross-checked
   * items where the primary and cross-check judge agree on this prediction's
   * question. Absent when no cross-check judge was configured or when fewer than
   * {@link CROSS_CHECK_MIN_ITEMS} items were sampled for this prediction.
   */
  crossCheckAgreement?: number;
  /**
   * True when this prediction had cross-check data but fewer than
   * {@link CROSS_CHECK_MIN_ITEMS} items — agreement is unknown and cannot
   * be used to downgrade the verdict. The verdict is left unchanged, but
   * the flag is surfaced in the report.
   */
  crossCheckTooFew?: boolean;
  /**
   * Set to 'judges disagree' when the verdict was downgraded from confirmed/
   * refuted to unclear because per-prediction cross-check agreement was below
   * {@link CROSS_CHECK_MIN_AGREEMENT} (#2413).
   */
  verdictReason?: 'judges disagree';
  /**
   * Paired per-probe sign-flip analysis (#2477 step 3). ADDITIVE secondary
   * analysis — never affects `verdict`, `rates`, or any existing field.
   *
   * Present when the verify phase ran and the prediction had at least one
   * targeted episode. Absent on pre-#2477 results and `unobservable`
   * predictions.
   */
  probeSignFlip?: import('./probe-signflip.js').ProbeSignFlipResult;
}

export interface DiscoveredDifference {
  id: string;
  description: string;
  question: string;
  rates: RateComparison;
}

export interface FeatureDelta {
  /** Plain-English feature label, e.g. "Asked before acting". */
  label: string;
  rates: RateComparison;
}

export interface VerifyResult {
  predictions: VerifiedPrediction[];
  discovered: DiscoveredDifference[];
  features: FeatureDelta[];
  episodes: number;
  samples: number;
  judge: { name: 'jev' | 'claude'; external: boolean; crossCheckAgreement?: number };
  /** Share of predictions confirmed, among confirmed + refuted (excludes 'unclear' and 'unobservable'). */
  predictionAccuracy?: number;
  truncatedByBudget: boolean;
  failedEpisodes: number;
  /** Outputs the judge could not grade; excluded from every rate. */
  judgeFailures?: number;
  /**
   * Per-failure records: arm, probe, error class, message, duration.
   * Empty when there were no failures; always present when verify ran (#2411).
   */
  failedEpisodeRecords?: import('./run.failures.js').FailedEpisodeRecord[];
  /**
   * Arm-imbalance flag: set when failures are significantly concentrated in
   * one arm, which biases verdicts toward "no change" (#2411).
   * Absent when the run had no failures or the imbalance was within threshold.
   */
  armImbalance?: import('./run.failures.js').ArmImbalance;
}

export interface WhatifReport {
  spec: ChangeSpec;
  structural: StructuralImpact;
  predictions: Prediction[];
  verify?: VerifyResult;
  costUsd: number;
  runDir: string;
  /** Plain-English caveats that always accompany the report. */
  limits: string[];
  headline: string;
  /** Probes dropped by probe-grounding because they reference non-existent paths. */
  droppedProbes?: import('./probe-grounding.js').DroppedProbe[];
  /**
   * Counts of turns/sessions excluded during corpus collection.
   * Present when the verify phase ran; lets callers see corpus shrinkage.
   */
  corpusExclusions?: import('./episodes.js').CorpusExclusions;
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

// Orchestration types (stages, progress, options, deps) live in their own
// module and are re-exported here so every consumer keeps importing from
// `./types.js`.
export type {
  WhatifStage,
  WhatifProgress,
  CompleteFn,
  WhatifOptions,
  WhatifDeps,
} from './types.orchestration.js';
