/**
 * Orchestration contract for the what-if engine: pipeline stages, progress
 * events, the model-call seam, run options, and injected dependencies.
 *
 * Split out of `./types.ts` (which re-exports everything here) to keep that
 * file under the 350-line limit. Import from `./types.js`, not this file.
 *
 * @module whatif/types.orchestration
 */

import type { AgentRunner, ChangeSpec, Judge } from './types.js';

export type WhatifStage =
  | 'compile'
  | 'sandbox'
  | 'snapshot'
  | 'predict'
  | 'episodes'
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
  /**
   * When set, the message should be printed persistently (not overwritten by
   * a spinner). Used for preflight summary lines such as the MDE warning.
   */
  persistent?: boolean;
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
