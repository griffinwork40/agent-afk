/**
 * Companion-primer subsystem barrel.
 *
 * Opt-in, bounded, reversible session priming from an operator-named primer
 * file (`AFK_COMPANION_PRIMER`). See {@link module:agent/companion/primer-loader}.
 *
 * @module agent/companion
 */

export {
  injectCompanionPrimer,
} from './primer-loader.js';
