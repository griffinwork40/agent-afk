/**
 * Trusted-skill badge formatter and registry.
 *
 * Pure formatter module — only imports chalk (external) and truncateDisplayWidth
 * from display.ts. No circular deps: does NOT import status-line, palette, or
 * any event module.
 */

import chalk from 'chalk';
import { truncateDisplayWidth, displayWidth } from './display.js';
import type { TrustedSkillResult } from '../agent/trusted-skill-result.js';
import { registerTrustedSkillName, clearTrustedSkillNamesForTesting } from '../agent/_lib/trusted-skill-registry.js';

export interface TrustedSkillRegistryEntry {
  glyph: string;
  color: string;        // hex string, e.g. '#7B5EA7'
  inFlightVerb: string; // e.g. 'verifying…'
}

// Module-level registry — private
const registry = new Map<string, TrustedSkillRegistryEntry>();

/**
 * Register a trusted skill. Idempotent on identical re-registration.
 * Throws on conflicting re-registration (different glyph, color, or inFlightVerb).
 *
 * Also registers the name in the agent-layer membership set so that
 * skill-executor.ts can check isTrustedSkill() without importing badge metadata.
 */
export function registerTrustedSkill(name: string, entry: TrustedSkillRegistryEntry): void {
  const existing = registry.get(name);
  if (existing) {
    if (
      existing.glyph === entry.glyph &&
      existing.color === entry.color &&
      existing.inFlightVerb === entry.inFlightVerb
    ) {
      // Idempotent — same config, silently accept
      return;
    }
    throw new Error(`Trusted skill "${name}" already registered with different config`);
  }
  registry.set(name, entry);
  // Keep the agent-layer membership set in sync (membership-only, no display metadata).
  registerTrustedSkillName(name);
}

/**
 * Clear the CLI badge registry AND the agent-layer name set. Test-only — not
 * guarded by env; restrict by convention (call only from afterEach / beforeEach
 * in test files).
 */
export function clearRegistryForTesting(): void {
  registry.clear();
  clearTrustedSkillNamesForTesting();
}

/**
 * Look up a registered trusted skill by name.
 */
export function getTrustedSkill(name: string): TrustedSkillRegistryEntry | undefined {
  return registry.get(name);
}

/**
 * Format duration in seconds with one decimal place.
 * NOTE: Do NOT replace with formatDuration from format-utils.ts — that rounds
 * to whole seconds.
 */
function formatDurationSec(ms: number): string {
  return (ms / 1000).toFixed(1) + 's';
}

export interface FormatTrustedSkillCompletionOpts {
  isTTY?: boolean;
  columns?: number;
}

/**
 * Format a trusted skill completion badge.
 *
 * TTY path (colored, glyphed):
 *   ◈ shadow-verified · 3 claims · 2 confirmed · 1 refuted · 1.2s
 *   ◈ shadow-verified · 3 claims · all confirmed · 1.2s
 *   ◈ shadow-verified · 1.2s
 *
 * Non-TTY / bracket path:
 *   [shadow-verified · 3/3 confirmed · 1.2s]
 *   [shadow-verified · 1.2s]
 *
 * Unknown skill (not in registry):
 *   [unknown-skill · 1.2s]
 */
export function formatTrustedSkillCompletion(
  result: TrustedSkillResult,
  opts?: FormatTrustedSkillCompletionOpts,
): string {
  const entry = getTrustedSkill(result.skillName);
  const durStr = formatDurationSec(result.durationMs);

  // Unknown skill — bracket form, no glyph, no color
  if (!entry) {
    const line = `[${result.skillName} · ${durStr}]`;
    return maybetruncate(line, opts?.columns);
  }

  const isTTY = opts?.isTTY !== false;

  if (isTTY) {
    let line: string;
    if (result.claimsTotal !== undefined) {
      // Build claim segment
      const allConfirmed =
        result.claimsTotal === result.claimsConfirmed &&
        result.claimsRefuted === undefined &&
        result.claimsInconclusive === undefined;

      let claimSegment: string;
      if (allConfirmed) {
        claimSegment = `${result.claimsTotal} claims · all confirmed`;
      } else {
        let seg = `${result.claimsTotal} claims`;
        if (result.claimsConfirmed !== undefined) seg += ` · ${result.claimsConfirmed} confirmed`;
        if (result.claimsRefuted !== undefined) seg += ` · ${result.claimsRefuted} refuted`;
        if (result.claimsInconclusive !== undefined) seg += ` · ${result.claimsInconclusive} inconclusive`;
        claimSegment = seg;
      }
      line = `${entry.glyph} ${result.skillName} · ${claimSegment} · ${durStr}`;
    } else {
      // Duration-only
      line = `${entry.glyph} ${result.skillName} · ${durStr}`;
    }

    const colored = chalk.hex(entry.color)(line);
    return maybetruncate(colored, opts?.columns);
  } else {
    // Non-TTY bracket form
    let line: string;
    if (result.claimsTotal !== undefined) {
      const confirmed = result.claimsConfirmed ?? 0;
      line = `[${result.skillName} · ${confirmed}/${result.claimsTotal} confirmed · ${durStr}]`;
    } else {
      line = `[${result.skillName} · ${durStr}]`;
    }
    return maybetruncate(line, opts?.columns);
  }
}

function maybetruncate(line: string, columns?: number): string {
  if (columns !== undefined && displayWidth(line) > columns) {
    return truncateDisplayWidth(line, columns);
  }
  return line;
}

export interface FormatTrustedSkillInFlightOpts {
  isTTY?: boolean;
  columns?: number;
}

/**
 * Format an in-flight trusted skill indicator as an inline scrollback badge.
 * Mirrors `formatTrustedSkillCompletion`'s shape so the in-flight and
 * completion badges visually pair up at the invocation point.
 *
 * TTY path (colored, glyphed):
 *   ◈ shadow-verify · verifying…
 *
 * Non-TTY / bracket path:
 *   [shadow-verify · verifying…]
 *
 * Unknown skill (not in registry):
 *   [unknown-skill · running…]
 */
export function formatTrustedSkillInFlight(
  skillName: string,
  opts?: FormatTrustedSkillInFlightOpts,
): string {
  const entry = getTrustedSkill(skillName);

  // Unknown skill — bracket form, no glyph, no color
  if (!entry) {
    const line = `[${skillName} · running…]`;
    return maybetruncate(line, opts?.columns);
  }

  const isTTY = opts?.isTTY !== false;

  if (isTTY) {
    const line = `${entry.glyph} ${skillName} · ${entry.inFlightVerb}`;
    const colored = chalk.hex(entry.color)(line);
    return maybetruncate(colored, opts?.columns);
  }

  const line = `[${skillName} · ${entry.inFlightVerb}]`;
  return maybetruncate(line, opts?.columns);
}
