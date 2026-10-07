import { beforeEach, expect, it } from 'vitest';
import { loadModelsCatalog, resetCatalogCache } from './models-catalog.js';
beforeEach(resetCatalogCache);
it('refreshes parsed windows when metadata changes, otherwise uses cache', () => {
  let revision = '1';
  let reads = 0;
  let window = 272000;
  const deps = { homedir: () => '/fake', revision: () => revision, readFile: () => {
    reads++;
    return JSON.stringify({ models: [{ slug: 'gpt-5.5', context_window: window, effective_context_window_percent: 95 }] });
  } };
  expect(loadModelsCatalog(deps).get('gpt-5.5')?.context_window).toBe(272000);
  window = 872000;
  expect(loadModelsCatalog(deps).get('gpt-5.5')?.context_window).toBe(272000);
  revision = '2';
  expect(loadModelsCatalog(deps).get('gpt-5.5')?.context_window).toBe(872000);
  expect(reads).toBe(2);
});
it('survives injected read failures and invalid numeric fields', () => {
  expect(loadModelsCatalog({ readFile: () => { throw new Error('missing'); } }).size).toBe(0);
  resetCatalogCache();
  const model = loadModelsCatalog({ readFile: () => JSON.stringify({ models: [{ slug: 'bad', context_window: -1, effective_context_window_percent: '95' }] }) }).get('bad');
  expect(model?.context_window).toBeUndefined();
  expect(model?.effective_context_window_percent).toBeUndefined();
});
