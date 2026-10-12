/** Bounded comma-list brace expansion; no shell escapes or numeric ranges. */
interface BraceGroup {
  start: number;
  end: number;
  commas: number[];
  scopeStart: number;
}

/** Unbalanced braces are literal, including otherwise valid inner groups. */
function braceGroups(pattern: string): BraceGroup[] {
  const stack: Array<{ start: number; commas: number[] }> = [];
  const groups: BraceGroup[] = [];
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern.charAt(i);
    if (ch === '{') stack.push({ start: i, commas: [] });
    else if (ch === ',') stack.at(-1)?.commas.push(i);
    else if (ch === '}') {
      const group = stack.pop();
      if (!group) return [];
      if (group.commas.length > 0) {
        groups.push({ ...group, end: i, scopeStart: stack[0]?.start ?? group.start });
      }
    }
  }
  return stack.length > 0 ? [] : groups.sort((a, b) => a.start - b.start);
}

/** Shared syntax recognition for the absolute-pattern literal-prefix splitter. */
export function firstBraceAlternation(pattern: string): number | undefined {
  return braceGroups(pattern)[0]?.scopeStart;
}

/**
 * Expand before glob compilation, preserving whole-segment globstar semantics
 * even for `{**,src}/...` and `{src/,}...`. One walker tests all alternatives,
 * so output ordering, deduplication and the global 500-entry cap stay unchanged.
 * Singletons/ranges remain literal; nested comma lists and empty arms work.
 * Backslash remains a Windows separator, not a newly introduced escape syntax.
 * Bound both fanout and aggregate size; never silently truncate alternatives.
 */
export function expandGlobBraces(pattern: string): string[] {
  const pending = [pattern];
  const expanded: string[] = [];
  let totalSize = pattern.length;
  while (pending.length > 0) {
    const current = pending.pop()!;
    const group = braceGroups(current)[0];
    if (!group) {
      expanded.push(current);
      continue;
    }
    const boundaries = [group.start, ...group.commas, group.end];
    if (pending.length + expanded.length + boundaries.length - 1 > 256) {
      throw new Error('Brace expansion exceeds limit (256 alternatives / 65536 characters); simplify the glob pattern');
    }
    const arms = boundaries.slice(0, -1).map((start, i) =>
      current.slice(0, group.start) + current.slice(start + 1, boundaries[i + 1]) + current.slice(group.end + 1),
    );
    totalSize += arms.reduce((sum, arm) => sum + arm.length, 0);
    if (totalSize > 65_536) {
      throw new Error('Brace expansion exceeds limit (256 alternatives / 65536 characters); simplify the glob pattern');
    }
    // Reverse because pending is a stack: preserve the caller's arm order.
    pending.push(...arms.reverse());
  }
  return [...new Set(expanded)];
}
