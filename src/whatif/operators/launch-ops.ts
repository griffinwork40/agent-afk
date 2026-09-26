/**
 * Launch-settings operators: model, effort, env.
 *
 * @module whatif/operators/launch-ops
 */

import type { ChangeOperator, Environment, OperatorContext } from '../types.js';

// ---------------------------------------------------------------------------
// Credential / reserved key guard
// ---------------------------------------------------------------------------

/**
 * Keys matching this pattern are credentials — reject them in the env operator.
 * Matches the same pattern used in sandbox afk.env stripping.
 */
const CREDENTIAL_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|OAUTH)/i;

/**
 * Reserved prefixes / exact keys that must not be overridden from whatif.
 */
const RESERVED_PREFIXES = ['AFK_WHATIF_'];
const RESERVED_EXACT = new Set(['AFK_HOME', 'AFK_STATE_DIR']);

function checkEnvKey(key: string): void {
  if (CREDENTIAL_KEY_RE.test(key)) {
    throw new Error(
      `[whatif] env operator: key "${key}" looks like a credential ` +
        `(matches /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|OAUTH)/i). ` +
        `Credentials are inherited from the parent process, not set via whatif.`,
    );
  }
  for (const prefix of RESERVED_PREFIXES) {
    if (key.startsWith(prefix)) {
      throw new Error(
        `[whatif] env operator: key "${key}" uses reserved prefix "${prefix}".`,
      );
    }
  }
  if (RESERVED_EXACT.has(key)) {
    throw new Error(
      `[whatif] env operator: key "${key}" is reserved and cannot be overridden via whatif.`,
    );
  }
}

// ---------------------------------------------------------------------------
// model
// ---------------------------------------------------------------------------

export const modelOperator: ChangeOperator<'model'> = {
  kind: 'model',

  touchesProject(_change) {
    return false;
  },

  homePathsToCopy(_change) {
    return [];
  },

  async apply(change, env: Environment, _ctx: OperatorContext) {
    env.launch.model = change.model;
  },

  describe(change) {
    return `Switch the model to ${change.model}`;
  },
};

// ---------------------------------------------------------------------------
// effort
// ---------------------------------------------------------------------------

export const effortOperator: ChangeOperator<'effort'> = {
  kind: 'effort',

  touchesProject(_change) {
    return false;
  },

  homePathsToCopy(_change) {
    return [];
  },

  async apply(change, env: Environment, _ctx: OperatorContext) {
    env.launch.effort = change.effort;
  },

  describe(change) {
    return `Set effort to "${change.effort}"`;
  },
};

// ---------------------------------------------------------------------------
// env
// ---------------------------------------------------------------------------

export const envOperator: ChangeOperator<'env'> = {
  kind: 'env',

  touchesProject(_change) {
    return false;
  },

  homePathsToCopy(_change) {
    return [];
  },

  async apply(change, env: Environment, _ctx: OperatorContext) {
    checkEnvKey(change.key);
    env.launch.env[change.key] = change.value;
  },

  describe(change) {
    return `Set environment variable ${change.key}=${JSON.stringify(change.value)}`;
  },
};
