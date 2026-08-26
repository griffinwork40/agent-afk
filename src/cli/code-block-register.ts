/**
 * Turn-scoped register of code blocks emitted by the markdown renderer.
 *
 * `renderCodeBlock()` pushes each block's raw text here at render time —
 * before ANSI codes and gutter decoration are applied — so `/copy N` can
 * retrieve clean, paste-ready source without re-parsing the markdown.
 *
 * The register is module-level mutable state. This is acceptable because
 * the REPL is single-threaded and turns are sequential. Call
 * `resetCodeBlockRegister()` at each turn boundary to prevent stale
 * entries from leaking across turns.
 *
 * Registration is gated on an `enabled` flag (default: `false`).  Only
 * the REPL loop enables registration (via `enableCodeBlockRegister()`)
 * alongside `resetCodeBlockRegister()`.  All other render paths — daemon,
 * subagent, one-shot, Telegram — leave the flag off, so
 * `registerCodeBlock()` is a no-op and the `blocks` array never accumulates
 * entries on non-REPL surfaces.
 */

export interface CodeBlockEntry {
  /** 1-based index within the current turn. */
  index: number;
  /** Language tag from the fence (e.g. "python", "bash"), or "text". */
  lang: string;
  /** Raw source text — no ANSI, no gutter decoration. */
  text: string;
}

const blocks: CodeBlockEntry[] = [];
let enabled = false;

/**
 * Enable registration.  Call once at REPL session start (alongside or
 * immediately before `resetCodeBlockRegister()`).  No-op if already enabled.
 */
export function enableCodeBlockRegister(): void {
  enabled = true;
}

/**
 * Disable registration.  After this call `registerCodeBlock()` is a no-op
 * again and no new entries are added to the register.
 */
export function disableCodeBlockRegister(): void {
  enabled = false;
}

/**
 * Record a code block and return its 1-based index.
 * Called by `renderCodeBlock` at render time.
 * No-op (returns 0) when the register is disabled.
 */
export function registerCodeBlock(lang: string, text: string): number {
  if (!enabled) return 0;
  const index = blocks.length + 1;
  blocks.push({ index, lang, text });
  return index;
}

/** All blocks registered in the current turn. */
export function getCodeBlocks(): readonly CodeBlockEntry[] {
  return blocks;
}

/** Retrieve a single block by 1-based index, or undefined if out of range. */
export function getCodeBlock(n: number): CodeBlockEntry | undefined {
  return blocks[n - 1];
}

/** Clear the register. Call at each turn boundary. */
export function resetCodeBlockRegister(): void {
  blocks.length = 0;
}
