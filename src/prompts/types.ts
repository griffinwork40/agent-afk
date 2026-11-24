/**
 * Core types for the PromptRegistry subsystem.
 *
 * A PromptEntry describes a single loadable prompt file — its identity,
 * classification, source location, and a lazy-load accessor. The registry
 * discovers entries via filesystem walking; loaders signal changes via
 * `notifyPromptLoaded()` so the cache is invalidated on dynamic load events.
 *
 * @module prompts/types
 */

/**
 * Classification of a prompt's origin / role in the system.
 *
 * - `framework`      — the core system-prompt.md shipped with the package
 * - `spine`          — SPINE classifier / init prompts (agent/spine/)
 * - `skill-phase`    — phase prompts bundled inside a named skill (skills/<name>/prompts/)
 * - `vendored-agent` — prompts shipped inside _agents/ (bundled agent definitions)
 * - `bundled-skill`  — prompts shipped inside a bundled plugin skill
 * - `user-skill`     — SKILL.md files discovered from ~/.afk/skills/ or <cwd>/.afk/skills/
 */
export type PromptKind =
  | 'framework'
  | 'spine'
  | 'skill-phase'
  | 'vendored-agent'
  | 'bundled-skill'
  | 'user-skill';

/**
 * A single registered prompt entry.
 *
 * The `id` field is the stable registry key: `${kind}:${relativePath}`.
 * `load()` returns the full prompt text; callers should not cache the result
 * across registry invalidations.
 */
export interface PromptEntry {
  /** Stable key: `${kind}:${relativePath}` */
  readonly id: string;
  readonly kind: PromptKind;
  /** Human-readable display name (typically the filename without extension). */
  readonly name: string;
  /** For skill-phase / bundled-skill / user-skill entries: the owning skill name. */
  readonly skill?: string;
  /** For multi-phase skills: the phase name derived from the filename. */
  readonly phase?: string;
  /** Absolute path to the source file on disk. */
  readonly sourcePath: string;
  /**
   * Path relative to the prompts root used as the unique key segment in `id`.
   * Example: `"spine/prompts/classifier.md"` or `"skills/mint/prompts/system.md"`.
   */
  readonly relativePath: string;
  /**
   * Whether an operator can safely edit this file and expect the change to
   * persist (true for user-skill SKILL.md, false for bundled/dist prompts).
   */
  readonly editable: boolean;
  /**
   * Whether this prompt's content is SHA-pinned in `.sdk-dependency.lock.json`
   * or similar integrity manifests.
   */
  readonly pinned: boolean;
  /**
   * Rough token count estimate for display / budget planning.
   * Computed as `Math.ceil(content.length / 4)` on first load.
   */
  readonly tokenEstimate: number;
  /**
   * Human-readable description of when/where this prompt is injected.
   * Example: `"injected as system prompt for mint skill phase 1"`.
   */
  readonly injectionContext: string;
  /** Load and return the prompt text. */
  load(): string;
}
