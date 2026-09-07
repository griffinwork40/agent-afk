import { env } from './env.js';

/** Default number of tail lines shown in the TUI bash output preview. */
export const DEFAULT_BASH_PREVIEW_TAIL_LINES = 7;

/** Default number of head lines shown in the TUI bash output preview (disabled by default). */
export const DEFAULT_BASH_PREVIEW_HEAD_LINES = 0;

/**
 * Maximum value accepted from either preview env var.
 *
 * Invariant: the ceiling keeps a typo (`500` for `5`) or an arbitrary large
 * value from inflating the TUI preview beyond any reasonable terminal height.
 * 50 lines sits well above any realistic preview window while still refusing
 * runaway values.
 */
export const BASH_PREVIEW_LINES_CEILING = 50;

type PreviewKey = 'AFK_BASH_PREVIEW_TAIL_LINES' | 'AFK_BASH_PREVIEW_HEAD_LINES';

interface PreviewDefinition {
  key: PreviewKey;
  defaultValue: number;
}

const definitions: readonly PreviewDefinition[] = [
  { key: 'AFK_BASH_PREVIEW_TAIL_LINES', defaultValue: DEFAULT_BASH_PREVIEW_TAIL_LINES },
  { key: 'AFK_BASH_PREVIEW_HEAD_LINES', defaultValue: DEFAULT_BASH_PREVIEW_HEAD_LINES },
];

const warnedKeys = new Set<PreviewKey>();

/**
 * Test-only: clear the once-per-key warning latch so a suite can assert the
 * warning fires regardless of what ran earlier in the file.
 *
 * Contract: production code must never call this.
 */
export function resetBashPreviewWarnings(): void {
  warnedKeys.clear();
}

function rawValueFor(key: PreviewKey): string | undefined {
  return env[key];
}

function resolvePreviewLines(definition: PreviewDefinition, warn = true): number {
  const rawValue = rawValueFor(definition.key);
  if (rawValue === undefined) {
    return definition.defaultValue;
  }

  // Accept non-negative integers only (including 0, which disables the preview).
  // Digit-anchored before Number() to reject "1e1", "0x8", "7.0", etc.
  const trimmed = rawValue.trim();
  const parsed = Number(trimmed);
  const isNonNegativeInteger =
    /^\d+$/.test(trimmed) && Number.isInteger(parsed) && parsed >= 0;

  if (isNonNegativeInteger && parsed <= BASH_PREVIEW_LINES_CEILING) {
    return parsed;
  }

  if (warn && !warnedKeys.has(definition.key)) {
    warnedKeys.add(definition.key);
    process.stderr.write(
      `[afk] Invalid ${definition.key}=${JSON.stringify(rawValue)}; ` +
        `using default ${definition.defaultValue}. Expected an integer in [0, ${BASH_PREVIEW_LINES_CEILING}].\n`,
    );
  }
  return definition.defaultValue;
}

/**
 * Resolve the configured tail-line count for bash output previews.
 *
 * Reads `AFK_BASH_PREVIEW_TAIL_LINES`. Returns `DEFAULT_BASH_PREVIEW_TAIL_LINES`
 * (7) when the var is unset, empty, non-numeric, negative, or above the ceiling.
 * 0 is valid and disables the tail preview entirely.
 */
export function resolvePreviewTailLines(): number {
  const def = definitions.find((d) => d.key === 'AFK_BASH_PREVIEW_TAIL_LINES')!;
  return resolvePreviewLines(def);
}

/**
 * Resolve the configured head-line count for bash output previews.
 *
 * Reads `AFK_BASH_PREVIEW_HEAD_LINES`. Returns `DEFAULT_BASH_PREVIEW_HEAD_LINES`
 * (0) when the var is unset, empty, non-numeric, negative, or above the ceiling.
 * 0 is valid and disables the head preview entirely (the default).
 */
export function resolvePreviewHeadLines(): number {
  const def = definitions.find((d) => d.key === 'AFK_BASH_PREVIEW_HEAD_LINES')!;
  return resolvePreviewLines(def);
}
