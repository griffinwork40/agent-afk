import { describe, it, expect } from 'vitest';
import { datePinnedCronWarning } from './schedule-cron-warning.js';

describe('date-pinned cron warning', () => {
  it.each(['30 20 12 10 *', '0 0 1 JAN *', '0 0 1 dec MON', ' 30  20 12 10 * '])('warns for %s', (cron) => {
    expect(datePinnedCronWarning({ cron }).warning).toContain('will NOT auto-disable');
  });
  it.each(['0 0 * * *', '0 0 12 * *', '0 0 * 10 *', '0 0 1,12 10 *', '0 0 1-12 10 *', '0 0 12 1/2 *'])('does not guess intent for %s', (cron) => {
    expect(datePinnedCronWarning({ cron })).toEqual({});
  });
  it('ignores a stored cron placeholder when runAt is set', () => {
    expect(datePinnedCronWarning({ cron: '30 20 12 10 *', runAt: '2099-10-12T20:30:00Z' })).toEqual({});
  });
});
