/**
 * Tests for `afk events` helpers.
 *
 * @module cli/commands/events.test
 */

import { describe, it, expect } from 'vitest';
import { resolveSecretEnvName } from './events.js';

describe('resolveSecretEnvName', () => {
  it('accepts the default registered secret', () => {
    expect(resolveSecretEnvName('AFK_EVENTS_WEBHOOK_SECRET')).toBe('AFK_EVENTS_WEBHOOK_SECRET');
  });

  it('rejects a registered but non-secret env var', () => {
    expect(resolveSecretEnvName('AFK_EVENTS_WEBHOOK_PORT')).toBeUndefined();
  });

  it('rejects unregistered names and object-prototype keys', () => {
    expect(resolveSecretEnvName('PATH')).toBeUndefined();
    expect(resolveSecretEnvName('constructor')).toBeUndefined();
    expect(resolveSecretEnvName('__proto__')).toBeUndefined();
    expect(resolveSecretEnvName('')).toBeUndefined();
  });
});
