/**
 * Turn-scoped register of copyable artifacts emitted by the markdown renderer.
 *
 * `renderCodeBlock()` pushes each block's raw text here at render time —
 * before ANSI codes and gutter decoration are applied — so `/copy N` can
 * retrieve clean, paste-ready source without re-parsing the markdown.
 *
 * `registerArtifact()` is the generic entry point for non-code artifacts
 * (inline shell commands, standalone URLs, `$`/`>`-prefixed prose commands).
 *
 * The register is module-level mutable state. This is acceptable because
 * the REPL is single-threaded and turns are sequential. Call
 * `resetCodeBlockRegister()` at each turn boundary to prevent stale
 * entries from leaking across turns.
 *
 * Registration is gated on an `enabled` flag (default: `false`).  Only
 * the REPL loop enables registration (via `enableCodeBlockRegister()`)
 * alongside `resetCodeBlockRegister()`.  All other render paths — daemon,
 * subagent, one-shot, Telegram — leave the flag off, so registration
 * functions are no-ops and the `artifacts` array never accumulates entries
 * on non-REPL surfaces.
 */

export type ArtifactType = 'code_block' | 'command' | 'url';

export interface ArtifactEntry {
  /** 1-based index within the current turn. */
  index: number;
  /** Artifact kind: fenced code block, inline CLI command, or URL. */
  type: ArtifactType;
  /**
   * Language tag for code_block (e.g. "python", "bash") or "text".
   * Empty string for command and url entries.
   */
  lang: string;
  /** Raw source text — no ANSI, no gutter decoration. */
  text: string;
}

/**
 * History (2026-08-27): CodeBlockEntry was the original exported interface.
 * Superseded by ArtifactEntry which adds the `type` discriminant. The alias
 * below keeps existing callers type-compatible without any changes on their
 * side — the new `type` field is additive.
 */
export type CodeBlockEntry = ArtifactEntry;

const artifacts: ArtifactEntry[] = [];
let enabled = false;

/**
 * Enable registration.  Call once at REPL session start (alongside or
 * immediately before `resetCodeBlockRegister()`).  No-op if already enabled.
 */
export function enableCodeBlockRegister(): void {
  enabled = true;
}

/**
 * Disable registration.  After this call all register functions are no-ops
 * and no new entries are added to the register.
 */
export function disableCodeBlockRegister(): void {
  enabled = false;
}

/**
 * Record any artifact and return its 1-based index.
 * No-op (returns 0) when the register is disabled.
 */
export function registerArtifact(type: ArtifactType, lang: string, text: string): number {
  if (!enabled) return 0;
  const index = artifacts.length + 1;
  artifacts.push({ index, type, lang, text });
  return index;
}

/**
 * Record a code block and return its 1-based index.
 * Called by `renderCodeBlock` at render time.
 * No-op (returns 0) when the register is disabled.
 */
export function registerCodeBlock(lang: string, text: string): number {
  return registerArtifact('code_block', lang, text);
}

/** All artifacts registered in the current turn. */
export function getCodeBlocks(): readonly ArtifactEntry[] {
  return artifacts;
}

/** Retrieve a single artifact by 1-based index, or undefined if out of range. */
export function getCodeBlock(n: number): ArtifactEntry | undefined {
  return artifacts[n - 1];
}

/** Clear the register. Call at each turn boundary. */
export function resetCodeBlockRegister(): void {
  artifacts.length = 0;
}
