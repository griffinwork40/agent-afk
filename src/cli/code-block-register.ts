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

/**
 * Record a code block and return its 1-based index.
 * Called by `renderCodeBlock` at render time.
 */
export function registerCodeBlock(lang: string, text: string): number {
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
