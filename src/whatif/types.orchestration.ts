/**
 * Orchestration contract for the what-if engine: pipeline stages, progress
 * events, the model-call seam, run options, and injected dependencies.
 *
 * Split out of `./types.ts` (which re-exports everything here) to keep that
 * file under the 350-line limit. Import from `./types.js`, not this file.
 *
 * @module whatif/types.orchestration
 */

import type { AgentRunner, ChangeSpec, Judge, OperatorPrediction } from './types.js';

export type WhatifStage =
  | 'compile'
  | 'sandbox'
  | 'snapshot'
  | 'predict'
  | 'episodes'
  | 'preflight'
  | 'run'
  | 'judge'
  | 'discover'
  | 'report';

export interface WhatifProgress {
  stage: WhatifStage;
  message: string;
  /** Optional completed/total for the current stage. */
  done?: number;
  total?: number;
}

/** Text-in/text-out model call used for predict, compile, judge, discover. */
export type CompleteFn = (req: {
  system: string;
  user: string;
  maxTokens: number;
  model: string;
  signal?: AbortSignal;
}) => Promise<{ text: string; costUsd: number }>;

export interface WhatifOptions {
  spec: ChangeSpec;
  realHome: string;
  realCwd: string;
  /** Model the agent under test uses (default: session / config model). */
  agentModel: string;
  /** Model for predict / compile / discover / Claude judge. */
  analystModel: string;
  verify: boolean;
  /** Real turns to replay. */
  turns: number;
  /** Samples per episode per environment. */
  samples: number;
  maxUsd: number;
  judge: 'auto' | 'jev' | 'claude';
  concurrency: number;
  maxTurns: number;
  episodeTimeoutMs: number;
  /** Keep sandboxes on disk after the run (debugging). */
  keepSandboxes: boolean;
  /** Bypass the MDE underpowered hard gate. */
  force?: boolean;
  /**
   * Number of synthetic probe episodes to generate per prediction (1–12).
   * Defaults to DEFAULT_PROBES (6) when omitted.
   */
  probes?: number;
  /**
   * Maximum number of predictions to retain from the analyst model's output.
   * Defaults are resolved by resolveMaxPredictions(probes).
   */
  maxPredictions?: number;
  /**
   * When true, skip the baseline-sample preflight (#2511).
   * The analyst-estimate headroom check is used instead when present.
   */
  noBaselineSample?: boolean;
  /**
   * Operator-supplied predictions (#2861). When non-empty, these are prepended
   * to analyst predictions. The analyst call is skipped entirely when this list
   * is non-empty and verify is not requested, so runs are deterministic.
   */
  operatorPredictions?: OperatorPrediction[];
}

export interface WhatifDeps {
  runner: AgentRunner;
  complete: CompleteFn;
  /** Resolves the judge for `options.judge`. */
  makeJudge(choice: WhatifOptions['judge']): Promise<Judge>;
  /** Claude judge used for the cross-check sample (may equal the main judge). */
  makeCrossCheckJudge(): Promise<Judge | undefined>;
  onProgress?: (p: WhatifProgress) => void;
  signal?: AbortSignal;
  now?: () => Date;
}
