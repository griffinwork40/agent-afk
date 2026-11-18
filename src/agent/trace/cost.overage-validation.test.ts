import { describe, expect, it } from 'vitest';
import { SessionCostAccumulator } from './cost.js';

describe('overage request counts read from traces (#4938)', () => {
  it.each([0.5, -1, NaN, Infinity, '1', undefined])('rejects an invalid request count %s and its cost', (requests) => {
    const acc = new SessionCostAccumulator();
    acc.add({ kind: 'closure', payload: { finalCostUsd: 2, overageCostUsd: 1, overageRequests: requests } });
    expect(acc.result()).not.toHaveProperty('overageCostUsd');
    expect(acc.result()).not.toHaveProperty('overageRequests');
  });

  it('keeps valid integer counts, including measured zero, without folding a corrupt pair', () => {
    const acc = new SessionCostAccumulator();
    acc.add({ kind: 'closure', payload: { finalCostUsd: 1, overageCostUsd: 0, overageRequests: 0 } });
    expect(acc.result()).toMatchObject({ overageCostUsd: 0, overageRequests: 0 });
    acc.add({ kind: 'closure', payload: { finalCostUsd: 2, overageCostUsd: 1, overageRequests: 0.5 } });
    acc.add({ kind: 'closure', payload: { finalCostUsd: 3, overageCostUsd: 2, overageRequests: 2 } });
    expect(acc.result()).toMatchObject({ totalCostUsd: 6, overageCostUsd: 2, overageRequests: 2 });
  });
});
