/**
 * Skill and plugin disable operators.
 *
 * @module whatif/operators/skill-plugin-ops
 */

import { unlinkSync, existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { ChangeOperator, OperatorContext } from '../types.js';

// ---------------------------------------------------------------------------
// disable-skill
// ---------------------------------------------------------------------------

export const disableSkillOperator: ChangeOperator<'disable-skill'> = {
  kind: 'disable-skill',

  touchesProject(_change) {
    return false;
  },

  homePathsToCopy(_change) {
    return [];
  },

  async apply(change, env, _ctx: OperatorContext) {
    const link = join(env.home, 'skills', change.name);
    if (!existsSync(link) && !symlinkExists(link)) {
      throw new Error(
        `[whatif] disable-skill: skill "${change.name}" not found at ${link}. ` +
          `Only user-scope skills (under $AFK_HOME/skills/) are supported. ` +
          `To disable a plugin-bundled skill, use disable-plugin instead.`,
      );
    }
    unlinkSync(link);
  },

  describe(change) {
    return `Disable skill "${change.name}"`;
  },
};

// ---------------------------------------------------------------------------
// disable-plugin
// ---------------------------------------------------------------------------

export const disablePluginOperator: ChangeOperator<'disable-plugin'> = {
  kind: 'disable-plugin',

  touchesProject(_change) {
    return false;
  },

  homePathsToCopy(_change) {
    return [];
  },

  async apply(change, env, _ctx: OperatorContext) {
    const pluginLink = join(env.home, 'plugins', change.name);
    const cacheLink = join(env.home, 'plugins', 'cache', change.name);

    const inPlugins = existsSync(pluginLink) || symlinkExists(pluginLink);
    const inCache = existsSync(cacheLink) || symlinkExists(cacheLink);

    if (!inPlugins && !inCache) {
      throw new Error(
        `[whatif] disable-plugin: plugin "${change.name}" not found at ` +
          `${pluginLink} or ${cacheLink}`,
      );
    }

    if (inPlugins) unlinkSync(pluginLink);
    if (inCache) unlinkSync(cacheLink);
  },

  describe(change) {
    return `Disable plugin "${change.name}"`;
  },
};

// ---------------------------------------------------------------------------
// Helper: lstat without following symlinks (detects dangling links)
// ---------------------------------------------------------------------------

function symlinkExists(p: string): boolean {
  try {
    const st = lstatSync(p);
    return st.isSymbolicLink();
  } catch {
    return false;
  }
}
