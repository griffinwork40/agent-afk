import { describe, expect, it, vi } from 'vitest';
import { createVersionNotice, VERSION_CHECK_INTERVAL_MS } from './version-notice.js';

describe('REPL version notice', () => {
  it('throttles disk reads and warns once per distinct installed version', () => {
    let time = 0;
    let disk = '5.283.0';
    const read = vi.fn(() => disk);
    const check = createVersionNotice('5.283.0', read, () => time);
    expect(check()).toBeUndefined();
    disk = '5.284.0';
    time = VERSION_CHECK_INTERVAL_MS - 1;
    expect(check()).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(1);
    time++;
    expect(check()).toContain('upgraded to v5.284.0 while this session is running v5.283.0');
    time += VERSION_CHECK_INTERVAL_MS;
    expect(check()).toBeUndefined();
    disk = '5.285.0';
    time += VERSION_CHECK_INTERVAL_MS;
    expect(check()).toContain('restart this session to pick up fixes');
    disk = '5.284.0';
    time += VERSION_CHECK_INTERVAL_MS;
    expect(check()).toBeUndefined();
    expect(read).toHaveBeenCalledTimes(5);
  });

  it.each(['', 'unknown'])('does not read disk when running version is %j', (version) => {
    const read = vi.fn(() => '5.284.0');
    expect(createVersionNotice(version, read)()).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('is disabled in dev/tsx with no build literal', () => {
    const read = vi.fn(() => '5.284.0');
    expect(createVersionNotice(undefined, read)()).toBeUndefined();
    expect(read).not.toHaveBeenCalled();
  });

  it('ignores an unknown disk version and retries after the interval', () => {
    let time = 0;
    const read = vi.fn().mockReturnValueOnce('unknown').mockReturnValueOnce('').mockReturnValue('5.284.0');
    const check = createVersionNotice('5.283.0', read, () => time);
    expect(check()).toBeUndefined();
    time += VERSION_CHECK_INTERVAL_MS;
    expect(check()).toBeUndefined();
    time += VERSION_CHECK_INTERVAL_MS;
    expect(check()).toContain('v5.284.0');
  });

  it('keeps warning state local to each REPL', () => {
    const read = () => '5.284.0';
    expect(createVersionNotice('5.283.0', read)()).toContain('v5.284.0');
    expect(createVersionNotice('5.283.0', read)()).toContain('v5.284.0');
  });
});
