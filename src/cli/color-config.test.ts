/**
 * Tests for color configuration autodetection.
 * Covers NO_COLOR, FORCE_COLOR, CI, TTY detection, and tmux truecolor override.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import chalk from 'chalk';
import { configureColor } from './color-config.js';

describe('configureColor()', () => {
  let originalChalkLevel: chalk.Level;

  beforeEach(() => {
    originalChalkLevel = chalk.level;
  });

  afterEach(() => {
    chalk.level = originalChalkLevel;
    vi.unstubAllEnvs();
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: undefined,
    });
  });

  it('sets chalk.level to 0 when NO_COLOR is set and non-empty', () => {
    vi.stubEnv('NO_COLOR', '1');
    vi.stubEnv('FORCE_COLOR', '');
    vi.stubEnv('CI', '');
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      get: () => true,
    });

    configureColor();
    expect(chalk.level).toBe(0);
  });

  it('leaves chalk.level unchanged when NO_COLOR is empty string', () => {
    vi.stubEnv('NO_COLOR', '');
    vi.stubEnv('FORCE_COLOR', '');
    vi.stubEnv('CI', '');
    vi.stubEnv('TMUX', '');
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      get: () => true,
    });

    const initialLevel = chalk.level;
    configureColor();
    expect(chalk.level).toBe(initialLevel);
  });

  it('FORCE_COLOR wins over NO_COLOR', () => {
    vi.stubEnv('NO_COLOR', '1');
    vi.stubEnv('FORCE_COLOR', '1');
    vi.stubEnv('CI', '');
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      get: () => true,
    });

    chalk.level = 3;
    const beforeLevel = chalk.level;
    configureColor();
    expect(chalk.level).toBe(beforeLevel);
  });

  it('sets chalk.level to 0 when CI is set and truthy (no FORCE_COLOR)', () => {
    vi.stubEnv('NO_COLOR', '');
    vi.stubEnv('FORCE_COLOR', '');
    vi.stubEnv('CI', 'true');
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      get: () => true,
    });

    configureColor();
    expect(chalk.level).toBe(0);
  });

  it('sets chalk.level to 0 when stdout is not a TTY (piped)', () => {
    vi.stubEnv('NO_COLOR', '');
    vi.stubEnv('FORCE_COLOR', '');
    vi.stubEnv('CI', '');
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      get: () => false,
    });

    configureColor();
    expect(chalk.level).toBe(0);
  });

  it('leaves chalk.level unchanged when no env vars set and isTTY=true', () => {
    vi.stubEnv('NO_COLOR', '');
    vi.stubEnv('FORCE_COLOR', '');
    vi.stubEnv('CI', '');
    vi.stubEnv('TMUX', '');
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      get: () => true,
    });

    const initialLevel = chalk.level;
    configureColor();
    expect(chalk.level).toBe(initialLevel);
  });

  it('sets chalk.level=3 when $TMUX is set and COLORTERM=truecolor (Node ≤24 workaround)', () => {
    vi.stubEnv('NO_COLOR', '');
    vi.stubEnv('FORCE_COLOR', '');
    vi.stubEnv('CI', '');
    vi.stubEnv('TMUX', '/tmp/tmux-501/default,12345,0');
    vi.stubEnv('COLORTERM', 'truecolor');
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      get: () => true,
    });

    chalk.level = 1;
    configureColor();
    expect(chalk.level).toBe(3);
  });

  it('sets chalk.level=3 when $TMUX is set and COLORTERM=24bit', () => {
    vi.stubEnv('NO_COLOR', '');
    vi.stubEnv('FORCE_COLOR', '');
    vi.stubEnv('CI', '');
    vi.stubEnv('TMUX', '/tmp/tmux-501/default,12345,0');
    vi.stubEnv('COLORTERM', '24bit');
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      get: () => true,
    });

    chalk.level = 1;
    configureColor();
    expect(chalk.level).toBe(3);
  });

  it('does not override chalk.level when $TMUX is set but COLORTERM is absent', () => {
    vi.stubEnv('NO_COLOR', '');
    vi.stubEnv('FORCE_COLOR', '');
    vi.stubEnv('CI', '');
    vi.stubEnv('TMUX', '/tmp/tmux-501/default,12345,0');
    vi.stubEnv('COLORTERM', '');
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      get: () => true,
    });

    const initialLevel = chalk.level;
    configureColor();
    expect(chalk.level).toBe(initialLevel);
  });
});
