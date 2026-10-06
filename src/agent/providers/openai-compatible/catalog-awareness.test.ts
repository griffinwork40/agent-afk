import { beforeEach, expect, it } from 'vitest';
import { availableCatalogModels, catalogUpgradeNotice } from './catalog-awareness.js';
import { resetCatalogCache } from './models-catalog.js';
import { withCatalogNotice, addForegroundNotices } from '../../tools/subagent-executor.notices.js';
beforeEach(resetCatalogCache);
const deps = { readFile: () => JSON.stringify({ models: [
  { slug: 'old', visibility: 'list', supported_in_api: true, priority: 13, context_window: 272000, effective_context_window_percent: 95, upgrade: { model: 'new', migration_markdown: 'Retires October 14.' } },
  { slug: 'new', visibility: 'list', supported_in_api: true, priority: 1, context_window: 272000, max_context_window: 872000 },
  { slug: 'hidden', visibility: 'hide', supported_in_api: true, priority: 2 },
  { slug: 'unsupported', visibility: 'list', supported_in_api: false, priority: 3 },
] }) };
it('filters, orders and exposes subscription windows and retirement notes', () => {
  const models = availableCatalogModels(deps);
  expect(models.map(m => m.slug)).toEqual(['new', 'old']);
  expect(models[1]?.effectiveInputLimit).toBe(258400);
  expect(models[1]?.upgrade?.migration_markdown).toContain('October 14');
});
it('emits successor trace and returns one line without substitution', async () => {
  const events: unknown[] = [];
  expect(catalogUpgradeNotice('old', { write: async event => { events.push(event); } }, deps)).toContain('new');
  await Promise.resolve();
  expect(events).toEqual([expect.objectContaining({ payload: expect.objectContaining({ phase: 'catalog_model_upgrade' }) })]);
  expect(catalogUpgradeNotice('missing', undefined, deps)).toBeUndefined();
});
it('adds metadata to foreground and background tool results', async () => {
  availableCatalogModels(deps);
  const foreground = { content: 'partial' };
  addForegroundNotices(foreground, 'old', false, undefined, 'read', true, undefined, undefined);
  expect(foreground.content).toContain('successor is new');
  const background = await withCatalogNotice(Promise.resolve({ content: 'job-id' }), 'old', undefined);
  expect(background.content).toContain('job-id');
  expect(background.content).toContain('successor is new');
});
