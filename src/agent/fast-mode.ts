export type FastModePreference = 'on' | 'off';
export type FastExecutionPath =
  | 'top-level' | 'child' | 'subagent' | 'skill' | 'compaction'
  | 'summarization' | 'one-shot' | 'auxiliary';
export type FastModeInactiveReason =
  | 'preference-off' | 'unsupported-provider' | 'custom-endpoint'
  | 'excluded-execution-path' | 'unsupported-model';

export interface FastModeContext {
  resolvedModelId: string;
  providerFamily: string;
  hasCustomEndpoint: boolean;
  executionPath: FastExecutionPath;
}

export type FastModeStatus = Readonly<{
  preference: FastModePreference;
  effective: boolean;
  reason?: FastModeInactiveReason;
}>;
export type FastTurnDecision = FastModeStatus;

const SUPPORTED_OPUS = /^claude-opus-(?:5|4-8)(?:-[a-z0-9][a-z0-9-]*)?$/;

export function resolveFastModeStatus(
  preference: FastModePreference,
  context: FastModeContext,
): FastModeStatus {
  if (preference === 'off') return Object.freeze({ preference, effective: false, reason: 'preference-off' });
  if (context.providerFamily !== 'anthropic-direct') return Object.freeze({ preference, effective: false, reason: 'unsupported-provider' });
  if (context.hasCustomEndpoint) return Object.freeze({ preference, effective: false, reason: 'custom-endpoint' });
  if (context.executionPath !== 'top-level') return Object.freeze({ preference, effective: false, reason: 'excluded-execution-path' });
  if (!SUPPORTED_OPUS.test(context.resolvedModelId)) return Object.freeze({ preference, effective: false, reason: 'unsupported-model' });
  return Object.freeze({ preference, effective: true });
}

export class FastModeController {
  private preference: FastModePreference;
  constructor(initial: FastModePreference = 'off') { this.preference = initial; }
  getPreference(): FastModePreference { return this.preference; }
  setPreference(preference: FastModePreference): void { this.preference = preference; }
  resolveStatus(context: FastModeContext): FastModeStatus {
    return resolveFastModeStatus(this.preference, context);
  }
  snapshotTurn(context: FastModeContext): FastTurnDecision {
    return this.resolveStatus(context);
  }
}
