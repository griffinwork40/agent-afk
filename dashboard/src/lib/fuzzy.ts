/**
 * Small fuzzy matcher for the ⌘K palette.
 *
 * Contract: returns a score in [0, 1]; 0 means "no match" (cmdk hides the
 * item). Ranking, best first: exact > prefix > word-start substring >
 * substring > in-order subsequence (bonus for consecutive and word-start
 * characters). Case-insensitive. An empty query matches everything at 1.
 */
export function fuzzyScore(text: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 1;
  const t = text.toLowerCase();
  if (!t) return 0;
  if (t === q) return 1;
  if (t.startsWith(q)) return 0.95;
  // Slash commands: "model" is a prefix match for "/model".
  if (t.startsWith('/') && !q.startsWith('/') && t.slice(1).startsWith(q)) return t.slice(1) === q ? 0.99 : 0.95;
  const at = t.indexOf(q);
  if (at > 0) return isWordStart(t, at) ? 0.9 : 0.8;
  // Subsequence: every query char in order.
  let ti = 0, hits = 0, run = 0, bonus = 0;
  for (const ch of q) {
    if (ch === ' ') continue;
    let found = -1;
    while (ti < t.length) { if (t[ti] === ch) { found = ti; break; } ti++; }
    if (found < 0) return 0;
    hits++;
    run = found > 0 && t[found - 1] === q[hits - 2] ? run + 1 : 0;
    bonus += (isWordStart(t, found) ? 2 : 0) + run;
    ti = found + 1;
  }
  const density = hits / Math.max(t.length, 1);
  return Math.min(0.7, 0.2 + 0.3 * density + 0.02 * bonus);
}

function isWordStart(t: string, i: number): boolean {
  return i === 0 || /[\s\-_/.:]/.test(t[i - 1] ?? '');
}

/** cmdk `filter`: score an item by its best keyword (never by its opaque value). */
export function paletteFilter(_value: string, search: string, keywords?: string[]): number {
  if (!keywords || keywords.length === 0) return 0;
  // The first keyword is the item's primary label. Secondary keywords (a model
  // tag, a description) are capped just below a label prefix match (0.95), so
  // typing a command's name always ranks it above commands that merely mention
  // the word in their summary.
  let best = 0;
  keywords.forEach((k, i) => {
    const s = fuzzyScore(k, search);
    best = Math.max(best, i === 0 ? s : Math.min(s, 0.93));
  });
  return best;
}
