/**
 * Public API barrel for the `insights` module.
 *
 * Consumers should import from this barrel rather than sub-paths.
 *
 * @module insights
 */

export { aggregateAll } from './aggregators/index.js';
export { evaluateRecommendations } from './recommendations.js';
export { generateHtml, htmlEscape } from './html.js';
export { openInBrowser } from './open.js';
export { aggregatePreexistingDefects } from './aggregators/index.js';

export type {
  InsightAggregates,
  InsightsOptions,
  Recommendation,
  RecommendationSeverity,
  SessionAggregates,
  TraceAggregates,
  DaemonAggregates,
  RoutingAggregates,
  OutcomeAggregates,
  OutcomeWeekCounts,
} from './types.js';
export type { PreexistingDefectAggregates } from './aggregators/preexisting-defects.js';
export type { DefectCluster } from '../agent/preexisting-ledger/reader.js';
