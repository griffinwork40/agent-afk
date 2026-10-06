import { expect, it } from 'vitest';
import { contextPressure, projectedContextTokens, traceContextPressure } from './context-pressure.js';
it('projects from one round and appended bytes, not cumulative billing usage', () => {
  expect(projectedContextTokens(1000, 300)).toBe(1100);
  expect(contextPressure(1000, 300, 2000)).toBe(false);
  expect(contextPressure(1600, 300, 2000)).toBe(true);
});
it('trace failure cannot change guard behavior', async () => {
  traceContextPressure({ write: async () => { throw new Error('offline'); } }, 100, 120);
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(contextPressure(100, 0, 120)).toBe(false);
});
