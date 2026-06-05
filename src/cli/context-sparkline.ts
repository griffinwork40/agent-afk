/**
 * Maps recent-turn ratios to a unicode sparkline.
 * @param ratios Array of numbers in [0, 1] representing turn context usage ratios.
 * @param n Number of recent ratios to include (defaults to 5). Takes the last n ratios.
 * @returns Unicode sparkline string with block characters (▁▂▃▄▅▆▇█).
 */
export function formatTurnSparkline(ratios: number[], n: number = 5): string {
  if (ratios.length === 0) {
    return '';
  }

  // Slice to last n ratios
  const sliced = ratios.slice(-n);

  // Map each ratio to a block character
  const blockChars = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

  return sliced
    .map((ratio) => {
      // Clamp ratio to [0, 1]
      const clamped = Math.max(0, Math.min(1, ratio));
      // Map to block character index: 0 → 0, 0.99 → 7, 1 → 7
      const index = Math.min(7, Math.floor(clamped * 8));
      return blockChars[index];
    })
    .join('');
}
