/**
 * Tests for color configuration autodetection.
 * Covers NO_COLOR, FORCE_COLOR, CI, and TTY detection logic.
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
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      get: () => true,
    });

    const initialLevel = chalk.level;
    configureColor();
    expect(chalk.level).toBe(initialLevel);
  });
});
