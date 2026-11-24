/**
 * Core types for the unified PromptRegistry.
 *
 * A PromptEntry is an immutable descriptor for a single prompt file discovered
 * on disk. The registry indexes all six prompt kinds — framework, spine,
 * skill-phase, vendored-agent, bundled-skill, and user-skill — using a
 * deterministic id of the form `${kind}:${relativePath}`.
 */

export type PromptKind =
  | 'framework'      // system-prompt.md at repo root
  | 'spine'          // src/agent/spine/prompts/*.md
  | 'skill-phase'    // src/skills/<name>/prompts/*.md
  | 'vendored-agent' // src/skills/_agents/prompts/*.md
  | 'bundled-skill'  // src/bundled-plugins/awa-bundled/skills/*/SKILL.md
  | 'user-skill';    // ~/.afk/skills/<name>/SKILL.md or <cwd>/.afk/skills/<name>/SKILL.md

export interface PromptEntry {
  /** Deterministic: `${kind}:${relativePath}` */
  readonly id: string;
  readonly kind: PromptKind;
  /** Human-readable label (e.g. "system-prompt", "mint/spec", "research-agent") */
  readonly name: string;
  /** Parent skill name — present for skill-phase and bundled-skill kinds */
  readonly skill?: string;
  /** Phase filename stem — present for skill-phase kind (e.g. "spec", "build") */
  readonly phase?: string;
  /** Absolute path on disk */
  readonly sourcePath: string;
  /** Relative to repo root (repo prompts) or user home (user-skill prompts) */
  readonly relativePath: string;
  /** Only user-skill entries are editable */
  readonly editable: boolean;
  /** True for vendored-agent entries (SHA-256 pinned in tree) */
  readonly pinned: boolean;
  /** Rough token estimate: Math.ceil(content.length / 4) */
  readonly tokenEstimate: number;
  /**
   * Human label describing where this prompt is injected.
   * E.g. "session system prompt", "skill phase (fork)", "spine classifier"
   */
  readonly injectionContext: string;
  /** Synchronous disk read of the prompt content */
  load(): string;
}
