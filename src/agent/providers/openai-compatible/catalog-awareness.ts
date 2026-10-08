import { loadModelsCatalog, type CatalogReaderDeps } from './models-catalog.js';
import { emitSessionPhase } from '../../trace/emit.js';
import type { TraceSink } from '../../trace/index.js';
import { resolveModelInput } from '../../session/model-slots.js';

/** Discovery metadata is subscription-specific, not an API-key availability promise. */
export function availableCatalogModels(deps: CatalogReaderDeps = {}) {
  return [...loadModelsCatalog(deps).values()]
    .filter(m => m.visibility === 'list' && m.supported_in_api === true)
    .sort((a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity))
    .map(m => ({
      slug: m.slug, priority: m.priority,
      contextWindow: m.context_window, maxContextWindow: m.max_context_window,
      effectiveInputLimit: m.context_window && m.effective_context_window_percent
        ? Math.floor(m.context_window * m.effective_context_window_percent / 100) : undefined,
      upgrade: m.upgrade,
    }));
}
export function catalogUpgradeNotice(model: string | undefined, trace?: TraceSink, deps: CatalogReaderDeps = {}): string | undefined {
  if (!model) return undefined;
  const id = resolveModelInput(model) ?? model;
  const upgrade = loadModelsCatalog(deps).get(id)?.upgrade;
  if (!upgrade) return undefined;
  const notice = `[Model catalog: ${id} upgrade successor is ${upgrade.model}; no automatic substitution.]`;
  void emitSessionPhase(trace, { phase: 'catalog_model_upgrade', metadata: { model: id, successor: upgrade.model } });
  return notice;
}
