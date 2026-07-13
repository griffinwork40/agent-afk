/**
 * Shared module-scope state for the plugin-skills command family.
 *
 * Invariant: `state` is a SINGLE module-level instance shared by the
 * dispatch, listing, and reload siblings. It must never be duplicated
 * across modules — consumers read the latest value through this module's
 * ES-module live binding, and reassignment happens only here via
 * `setState()` (ESM importers cannot reassign an imported binding).
 */

export interface DiscoveredSkill {
  /** Name as reported by `session.supportedCommands()` — may include a `<plugin>:` namespace. */
  name: string;
  description: string;
  argumentHint?: string;
}

/** Track collisions detected at registration time so /skills can render alts and boot can notify. */
export interface PluginCollision {
  /** Bare name shared between vendored/user winner and the plugin alt. */
  bare: string;
  /** Slash form of the surviving plugin alt (e.g. `/example-plugin:mint`). */
  altSlash: string;
  /** Description from the plugin side, for the alt continuation row. */
  altDescription: string;
}

export interface PluginSkillsState {
  discovered: DiscoveredSkill[];
  collisions: PluginCollision[];
  /** Set of bare names whose plugin form was registered under a fallback (collision). */
  shadowedBareNames: Set<string>;
}

export let state: PluginSkillsState = {
  discovered: [],
  collisions: [],
  shadowedBareNames: new Set(),
};

/** Replace the module-scope state. Only this module may reassign the binding. */
export function setState(next: PluginSkillsState): void {
  state = next;
}

/** Strip the `<plugin>:` namespace prefix from a skill name. */
export function bareName(name: string): string {
  return name.includes(':') ? name.split(':').pop()! : name;
}
