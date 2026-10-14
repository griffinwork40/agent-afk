/**
 * Template-mode proposal engine.
 *
 * Given a {@link FailureCard}, deterministically produces an
 * {@link ImprovementProposal} populated from a static pattern -> starter
 * map. No LLM calls, no file-system access, no network. Pure.
 *
 * The goal is NOT to produce a finished fix — it's to produce a starter
 * proposal a human reviewer refines before any patch lands. The template
 * provides:
 *
 *   - A hypothesis sentence honestly framed as a guess.
 *   - A coarse root-cause class.
 *   - Pointers to files MOST commonly related to the pattern (verified
 *     against the repo layout as of this commit).
 *   - The canonical forbidden-path globs from
 *     {@link DEFAULT_FORBIDDEN_PATH_GLOBS}.
 *   - A validation plan whose unit tests reference real existing files.
 *
 * Every template marks `confidence: 'low' | 'medium'` on its file
 * suggestions — never `'high'` without a human review. The proposal's
 * top-level `riskLevel` is derived from the worst `likelyFiles[].riskTier`.
 *
 * ## Why these specific files?
 *
 * The file pointers below are grounded in the repo as of the commit that
 * introduces this module. They are deliberately conservative — each entry
 * is a file the detector pattern is materially related to, never a guess.
 * When the codebase moves, the templates need to move too (these are
 * implementation references, not philosophy).
 *
 * Pattern template records are split across siblings by concern family:
 *   - {@link ./template-engine.templates-loop} — loop/hook patterns
 *     (`repeated-tool-use`, `subagent-block`, `subagent-read-denial`)
 *   - {@link ./template-engine.templates-density} — density/closure patterns
 *     (`tool-failure-density`, `closure-anomaly`)
 *
 * @module improve/propose/template-engine
 */

import {
  DEFAULT_FORBIDDEN_PATH_GLOBS,
  type FailureCard,
  type ImprovementProposal,
  type LikelyFile,
  type RootCauseClass,
  type Severity,
  type ValidationPlan,
} from '../schemas.js';
import {
  repeatedToolUseTemplate,
  subagentBlockTemplate,
  subagentReadDenialTemplate,
} from './template-engine.templates-loop.js';
import {
  toolFailureDensityTemplate,
  closureAnomalyTemplate,
  closureAdviceFor as _closureAdviceFor,
} from './template-engine.templates-density.js';

/** Optional injection seam for deterministic tests. */
export interface TemplateContext {
  /** Override the proposal id. Tests use this; production uses the
   *  generator in `writer.ts`. */
  proposalId: string;
  /** Override the timestamp source. Tests use this; production defaults to `new Date()`. */
  now?: () => Date;
}

/**
 * The per-pattern starter contents. Kept as a discriminated lookup so the
 * compiler catches missing pattern handlers when the enum grows.
 */
interface PatternTemplate {
  rootCauseClass: RootCauseClass;
  hypothesis(card: FailureCard): string;
  fixSketch(card: FailureCard): string;
  likelyFiles: readonly LikelyFile[];
  /** Severity floor for the proposal's `riskLevel`. The final risk is the
   *  MAX of this and the worst likelyFiles tier. */
  riskFloor: Severity;
  validationPlan: ValidationPlan;
}

const TEMPLATES: Record<FailureCard['pattern'], PatternTemplate> = {
  'repeated-tool-use': repeatedToolUseTemplate,
  'subagent-block': subagentBlockTemplate,
  'subagent-read-denial': subagentReadDenialTemplate,
  'tool-failure-density': toolFailureDensityTemplate,
  'closure-anomaly': closureAnomalyTemplate,
};

/**
 * Build a starter proposal from a card. Deterministic given the same
 * inputs. Throws if the card's pattern is unknown to the template engine
 * (would indicate a schema/template drift — fail loudly).
 */
export function proposeFromCard(card: FailureCard, ctx: TemplateContext): ImprovementProposal {
  const template = TEMPLATES[card.pattern];
  if (!template) {
    throw new Error(
      `template-engine: no template for pattern '${card.pattern}' — add one to TEMPLATES`,
    );
  }

  const createdAt = (ctx.now ?? (() => new Date()))().toISOString();
  const hypothesis = template.hypothesis(card);
  const fixSketch = template.fixSketch(card);
  const likelyFiles = template.likelyFiles.map((f) => ({ ...f }));

  // Compute risk: MAX of riskFloor and worst likelyFiles tier.
  const riskLevel = deriveRiskLevel(template.riskFloor, likelyFiles);

  // Evidence refs back to the card: one per evidence row.
  const evidenceRefs = card.evidence.map((ev) => ({
    cardSlug: card.slug,
    eventIndices: [...ev.eventIndices],
    ...(ev.annotation !== undefined ? { annotation: ev.annotation } : {}),
  }));

  return {
    schemaVersion: 1,
    proposalId: ctx.proposalId,
    cardSlug: card.slug,
    title: buildTitle(card),
    hypothesis,
    rootCauseClass: template.rootCauseClass,
    evidenceRefs,
    fixSketch,
    likelyFiles,
    riskLevel,
    validationPlan: structuredCloneShallow(template.validationPlan),
    scopeFreeze: {
      forbiddenPaths: [...DEFAULT_FORBIDDEN_PATH_GLOBS],
      requiresExplicitApproval: riskLevel === 'high',
    },
    generatedBy: 'template',
    createdAt,
    status: 'draft',
    notes: [],
  };
}

/**
 * Risk derivation. Goal: never UNDERESTIMATE risk.
 *
 *   - Worst tier `forbidden` -> high (and `requiresExplicitApproval: true`
 *     downstream).
 *   - Worst tier `high` -> high.
 *   - Worst tier `moderate` -> max(floor, 'medium').
 *   - Worst tier `safe` -> floor.
 */
export function deriveRiskLevel(
  floor: Severity,
  files: readonly LikelyFile[],
): Severity {
  const fileTier = worstTier(files);
  if (fileTier === 'forbidden' || fileTier === 'high') return 'high';
  if (fileTier === 'moderate') return maxSeverity(floor, 'medium');
  return floor;
}

function worstTier(files: readonly LikelyFile[]): 'safe' | 'moderate' | 'high' | 'forbidden' {
  const order = ['safe', 'moderate', 'high', 'forbidden'] as const;
  let worstIdx = 0;
  for (const f of files) {
    const idx = order.indexOf(f.riskTier);
    if (idx > worstIdx) worstIdx = idx;
  }
  return order[worstIdx]!;
}

const SEV_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2 };
function maxSeverity(a: Severity, b: Severity): Severity {
  return SEV_RANK[a] >= SEV_RANK[b] ? a : b;
}

function buildTitle(card: FailureCard): string {
  return `Proposal: address ${card.pattern} — ${card.title}`.slice(0, 200);
}

/**
 * Shallow clone of the validation plan (arrays only — strings are
 * immutable). Avoids the proposal's arrays aliasing the template's.
 */
function structuredCloneShallow(plan: ValidationPlan): ValidationPlan {
  return {
    unitTests: [...plan.unitTests],
    evalCases: [...plan.evalCases],
    smokeChecks: [...plan.smokeChecks],
    manualChecks: [...plan.manualChecks],
  };
}

// Re-export closureAdviceFor so existing test imports that reference it from
// this module path continue to resolve without change.
export { _closureAdviceFor as closureAdviceFor };
