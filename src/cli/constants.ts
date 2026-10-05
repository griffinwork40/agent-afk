/**
 * Flavour-only spinner verbs for model thinking and streaming.
 * Real tool work uses the shared vocabulary in cli/tool-category.ts instead.
 */

export const SPINNER_VERBS: string[] = [
  "Stalking",
  "Shadowing",
  "Tailing",
  "Casing",
  "Sleuthing",
  "Deducing",
  "Interrogating",
  "Profiling",
  "Canvassing",
  "Prowling",
  "Lurking",
  "Hunting",
  "Triangulating",
  "Decoding",
  "Unmasking",
  "Cornering",
  "Surveilling",
  "Pondering",
  "Mulling",
  "Brooding",
  "Ruminating",
  "Musing",
];

/**
 * Goblin-flavored present-participle verbs used by the spinner when the goblin
 * theme is active (AFK_GOBLIN_SPINNER). Same "<verb>..." shape as SPINNER_VERBS
 * so the renderer is theme-agnostic; only the word pool + colour change.
 * Keep flavour distinct from real tool work and from the noir pool.
 */
export const GOBLIN_SPINNER_VERBS: string[] = [
  "Scheming",
  "Skittering",
  "Gnawing",
  "Cackling",
  "Plotting",
  "Scuttling",
  "Conniving",
  "Snickering",
  "Rummaging",
  "Scrounging",
  "Scrabbling",
  "Muttering",
];

export function pickRandomVerb(): string {
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]!;
}

export function pickRandomGoblinVerb(): string {
  return GOBLIN_SPINNER_VERBS[Math.floor(Math.random() * GOBLIN_SPINNER_VERBS.length)]!;
}
