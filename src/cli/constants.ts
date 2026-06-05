/**
 * Spinner and completion verb constants for CLI output.
 */

export const SPINNER_VERBS: string[] = [
  "Stalking",
  "Shadowing",
  "Tailing",
  "Casing",
  "Sleuthing",
  "Investigating",
  "Deducing",
  "Interrogating",
  "Profiling",
  "Canvassing",
  "Prowling",
  "Lurking",
  "Scanning",
  "Probing",
  "Inspecting",
  "Querying",
  "Invoking",
  "Parsing",
  "Validating",
  "Resolving",
  "Compiling",
  "Executing",
  "Hunting",
  "Sweeping",
  "Tracing",
  "Tracking",
  "Triangulating",
  "Decoding",
  "Decrypting",
  "Intercepting",
  "Hacking",
  "Bugging",
  "Wiretapping",
  "Dispatching",
  "Deploying",
  "Patching",
  "Hooking",
  "Unmasking",
  "Cornering",
  "Striking",
  "Surveilling",
  "Scouting",
];

export const COMPLETION_VERBS: Record<string, string> = {
  Sweeping: "Swept",
  Striking: "Struck",
};

export function pickRandomVerb(): string {
  return SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]!;
}

export function getCompletionVerb(verb: string): string {
  const mapped = COMPLETION_VERBS[verb];
  if (mapped) {
    return mapped;
  }
  if (verb.endsWith("e")) {
    return verb + "d";
  }
  if (verb.endsWith("ing")) {
    return verb.slice(0, -3) + "ed";
  }
  return verb + "ed";
}
