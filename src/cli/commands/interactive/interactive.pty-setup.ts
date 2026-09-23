/**
 * Pre-arm anchor-row measurement for `interactive.ts`.
 *
 * The persistent compositor needs to know which cursor row it may START from
 * so it never CUP-overwrites the pre-arm scrollback (banner, update notices,
 * boot warnings). The approach: monkey-patch `process.stdout.write` and
 * `process.stderr.write` to count `\n` bytes during the pre-arm print block,
 * then restore both streams unconditionally in a `finally` so a thrown banner
 * formatter can never strand the patch on the global streams.
 *
 * Why both streams: `printUpdateBanner` writes to stderr and the banner writes
 * to stdout, but both advance the same terminal cursor (they share the TTY).
 * Counting only one stream would undershoot.
 */

/** Newline count during the pre-arm print block + cursor start row = anchor row. */
export interface AnchorRowResult {
  /** The first row the compositor may use (1-based). Equals newlines printed + 1. */
  anchorRow: number;
}

/**
 * Run `block()` while monkey-patching stdout/stderr to count newlines, then
 * restore both streams. Returns the anchor row to pass to `surface.armCompositor`.
 *
 * The patch is always removed in a `finally` — safe if `block` throws.
 */
export async function measurePreArmAnchorRow(
  block: () => Promise<void> | void,
): Promise<AnchorRowResult> {
  let preArmAnchorRow = 1; // cursor row after `\x1b[H` (CUP-home)

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  const countNewlines = (chunk: unknown): number => {
    const s =
      typeof chunk === 'string'
        ? chunk
        : chunk instanceof Uint8Array
          ? Buffer.from(chunk).toString('utf8')
          : String(chunk);
    return s.match(/\n/g)?.length ?? 0;
  };

  const wrapWrite =
    (orig: typeof process.stdout.write): typeof process.stdout.write =>
    ((chunk: unknown, ...rest: unknown[]): boolean => {
      preArmAnchorRow += countNewlines(chunk);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (orig as any)(chunk, ...rest);
    }) as typeof process.stdout.write;

  process.stdout.write = wrapWrite(origStdoutWrite);
  process.stderr.write = wrapWrite(origStderrWrite);

  try {
    await block();
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
  }

  return { anchorRow: preArmAnchorRow };
}
