import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_BASH_PREVIEW_TAIL_LINES,
  DEFAULT_BASH_PREVIEW_HEAD_LINES,
  BASH_PREVIEW_LINES_CEILING,
  resolvePreviewTailLines,
  resolvePreviewHeadLines,
  resetBashPreviewWarnings,
} from './bash-preview.js';

beforeEach(() => {
  resetBashPreviewWarnings();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('resolvePreviewTailLines', () => {
  it('returns the default (7) when unset', () => {
    vi.stubEnv('AFK_BASH_PREVIEW_TAIL_LINES', undefined);
    expect(resolvePreviewTailLines()).toBe(DEFAULT_BASH_PREVIEW_TAIL_LINES);
    expect(DEFAULT_BASH_PREVIEW_TAIL_LINES).toBe(7);
  });

  it('returns a valid positive integer from the environment', () => {
    vi.stubEnv('AFK_BASH_PREVIEW_TAIL_LINES', '15');
    expect(resolvePreviewTailLines()).toBe(15);
  });

  it('accepts 0 (disables tail preview)', () => {
    vi.stubEnv('AFK_BASH_PREVIEW_TAIL_LINES', '0');
    expect(resolvePreviewTailLines()).toBe(0);
  });

  it('accepts the ceiling value exactly', () => {
    vi.stubEnv('AFK_BASH_PREVIEW_TAIL_LINES', String(BASH_PREVIEW_LINES_CEILING));
    expect(resolvePreviewTailLines()).toBe(BASH_PREVIEW_LINES_CEILING);
  });

  it('falls back and warns for a value above the ceiling', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubEnv('AFK_BASH_PREVIEW_TAIL_LINES', String(BASH_PREVIEW_LINES_CEILING + 1));
    expect(resolvePreviewTailLines()).toBe(DEFAULT_BASH_PREVIEW_TAIL_LINES);
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toContain('AFK_BASH_PREVIEW_TAIL_LINES');
    expect(String(write.mock.calls[0]?.[0])).toContain(`Expected an integer in [0, ${BASH_PREVIEW_LINES_CEILING}]`);
  });

  it('falls back and warns for a negative value', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubEnv('AFK_BASH_PREVIEW_TAIL_LINES', '-1');
    expect(resolvePreviewTailLines()).toBe(DEFAULT_BASH_PREVIEW_TAIL_LINES);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('falls back and warns for a non-numeric value', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubEnv('AFK_BASH_PREVIEW_TAIL_LINES', 'ten');
    expect(resolvePreviewTailLines()).toBe(DEFAULT_BASH_PREVIEW_TAIL_LINES);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('warns only once per unique invalid key', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubEnv('AFK_BASH_PREVIEW_TAIL_LINES', 'bad');
    resolvePreviewTailLines();
    resolvePreviewTailLines();
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each(['0x8', '1e1', '7.5', '+7', ' '])(
    'rejects %j — a non-decimal grammar Number() would otherwise accept',
    (raw) => {
      const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      vi.stubEnv('AFK_BASH_PREVIEW_TAIL_LINES', raw);
      expect(resolvePreviewTailLines()).toBe(DEFAULT_BASH_PREVIEW_TAIL_LINES);
      expect(write).toHaveBeenCalledTimes(1);
    },
  );

  it('accepts surrounding whitespace and leading zeros', () => {
    vi.stubEnv('AFK_BASH_PREVIEW_TAIL_LINES', ' 03 ');
    expect(resolvePreviewTailLines()).toBe(3);
  });

  it('falls back for an absurdly large value', () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubEnv('AFK_BASH_PREVIEW_TAIL_LINES', '1000000000');
    expect(resolvePreviewTailLines()).toBe(DEFAULT_BASH_PREVIEW_TAIL_LINES);
  });
});

describe('resolvePreviewHeadLines', () => {
  it('returns the default (0) when unset', () => {
    vi.stubEnv('AFK_BASH_PREVIEW_HEAD_LINES', undefined);
    expect(resolvePreviewHeadLines()).toBe(DEFAULT_BASH_PREVIEW_HEAD_LINES);
    expect(DEFAULT_BASH_PREVIEW_HEAD_LINES).toBe(0);
  });

  it('returns a valid positive integer from the environment', () => {
    vi.stubEnv('AFK_BASH_PREVIEW_HEAD_LINES', '3');
    expect(resolvePreviewHeadLines()).toBe(3);
  });

  it('accepts 0 explicitly', () => {
    vi.stubEnv('AFK_BASH_PREVIEW_HEAD_LINES', '0');
    expect(resolvePreviewHeadLines()).toBe(0);
  });

  it('accepts the ceiling value exactly', () => {
    vi.stubEnv('AFK_BASH_PREVIEW_HEAD_LINES', String(BASH_PREVIEW_LINES_CEILING));
    expect(resolvePreviewHeadLines()).toBe(BASH_PREVIEW_LINES_CEILING);
  });

  it('falls back and warns for a value above the ceiling', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubEnv('AFK_BASH_PREVIEW_HEAD_LINES', String(BASH_PREVIEW_LINES_CEILING + 1));
    expect(resolvePreviewHeadLines()).toBe(DEFAULT_BASH_PREVIEW_HEAD_LINES);
    expect(write).toHaveBeenCalledTimes(1);
    expect(String(write.mock.calls[0]?.[0])).toContain('AFK_BASH_PREVIEW_HEAD_LINES');
  });

  it('falls back and warns for a negative value', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubEnv('AFK_BASH_PREVIEW_HEAD_LINES', '-5');
    expect(resolvePreviewHeadLines()).toBe(DEFAULT_BASH_PREVIEW_HEAD_LINES);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('falls back and warns for a non-numeric value', () => {
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.stubEnv('AFK_BASH_PREVIEW_HEAD_LINES', 'nope');
    expect(resolvePreviewHeadLines()).toBe(DEFAULT_BASH_PREVIEW_HEAD_LINES);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
