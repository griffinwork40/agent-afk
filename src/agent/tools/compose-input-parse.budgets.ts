/** Budget parsing for compose input. Validation and warning order are caller-visible. */

// Bounds reject sub-second unit mistakes and clamp multi-hour deadlines.
const MIN_NODE_TIMEOUT_MS = 1_000;
const MAX_NODE_TIMEOUT_MS = 3_600_000;

// Zero means uncapped downstream; require at least one tool-using round.
const MIN_NODE_TOOL_ROUNDS = 1;
const MAX_NODE_TOOL_ROUNDS = 1_000;

/** Validate and return a positive integer tool-round budget from raw input. */
export function parseToolRounds(val: unknown, key: string): number {
  if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
    throw new Error(`"${key}" must be a positive finite number`);
  }
  if (!Number.isInteger(val)) {
    throw new Error(
      `"${key}" must be an integer (got ${val}). ` +
      `Tool-use rounds are discrete events; fractional budgets are not meaningful.`,
    );
  }
  if (val < MIN_NODE_TOOL_ROUNDS) {
    throw new Error(`"${key}" must be at least ${MIN_NODE_TOOL_ROUNDS}`);
  }
  if (val > MAX_NODE_TOOL_ROUNDS) {
    throw new Error(
      `"${key}" must be at most ${MAX_NODE_TOOL_ROUNDS} ` +
      `(got ${val}). A larger budget no longer constrains useful work.`,
    );
  }
  return val;
}

/** Parse timeout before tool-round aliases, preserving error and warning precedence. */
export function parseComposeBudgets(obj: Record<string, unknown>): {
  nodeTimeoutMs: number | undefined;
  maxToolRoundsPerNode: number | undefined;
  warnings: string[];
} {
  const warnings: string[] = [];

  let nodeTimeoutMs: number | undefined;
  if (obj['node_timeout_ms'] !== undefined) {
    const val = obj['node_timeout_ms'];
    if (typeof val !== 'number' || !Number.isFinite(val) || val <= 0) {
      throw new Error('"node_timeout_ms" must be a positive finite number (milliseconds)');
    }
    if (val < MIN_NODE_TIMEOUT_MS) {
      throw new Error(
        `"node_timeout_ms" must be at least ${MIN_NODE_TIMEOUT_MS}ms ` +
        `(got ${val}). Sub-second timeouts are almost always a unit mistake.`,
      );
    }
    // Upper clamp: cap rather than reject — a very large value expresses
    // intent ("a long deadline is fine") and clamping preserves forward
    // progress. Surface a warning so the model knows its value was adjusted.
    nodeTimeoutMs = Math.min(MAX_NODE_TIMEOUT_MS, val);
    if (val > MAX_NODE_TIMEOUT_MS) {
      warnings.push(
        `node_timeout_ms clamped: requested ${val}ms exceeds the maximum ` +
        `${MAX_NODE_TIMEOUT_MS}ms; using ${MAX_NODE_TIMEOUT_MS}ms.`,
      );
    }
  }

  // `max_tool_calls_per_node` is the pre-wind-down name for the same knob and
  // is still accepted; the preferred key wins when both are present so a
  // caller migrating incrementally never silently gets the older value.
  const ROUNDS_KEY = 'max_tool_rounds_per_node';
  const LEGACY_ROUNDS_KEY = 'max_tool_calls_per_node';
  const usedKey = obj[ROUNDS_KEY] !== undefined ? ROUNDS_KEY : LEGACY_ROUNDS_KEY;
  if (obj[ROUNDS_KEY] !== undefined && obj[LEGACY_ROUNDS_KEY] !== undefined) {
    warnings.push(
      `both "${ROUNDS_KEY}" and the deprecated "${LEGACY_ROUNDS_KEY}" were ` +
      `supplied; using "${ROUNDS_KEY}" and ignoring the deprecated key.`,
    );
  } else if (obj[LEGACY_ROUNDS_KEY] !== undefined) {
    warnings.push(
      `"${LEGACY_ROUNDS_KEY}" is deprecated — use "${ROUNDS_KEY}". The unit ` +
      `is tool-use ROUNDS (a round with N parallel calls costs 1), and ` +
      `spending the budget now triggers a tools-stripped wind-down round ` +
      `instead of cancelling the node.`,
    );
  }

  let maxToolRoundsPerNode: number | undefined;
  if (obj[usedKey] !== undefined) {
    maxToolRoundsPerNode = parseToolRounds(obj[usedKey], usedKey);
  }

  return { nodeTimeoutMs, maxToolRoundsPerNode, warnings };
}
