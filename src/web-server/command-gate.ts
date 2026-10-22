/** Derive web availability from positive command requirements. */
import { lookup } from '../cli/slash/registry.js';
import {
  capabilityReason,
  missingCapabilities,
  webCapabilities,
  type SurfaceCapability,
} from '../cli/slash/capabilities.js';

/**
 * Explicit deferrals for commands a surface could run but that are not wired
 * yet. Empty since Stages 3 and 4: every web gate is now derived from
 * capabilities. Add an entry (with a user-facing reason) only as a stopgap.
 */
const DEFERRED: ReadonlyMap<string, string> = new Map();

/** True when the web context cannot satisfy a registered command's requirements. */
export function isGated(
  name: string,
  provided: ReadonlySet<SurfaceCapability> = webCapabilities(),
): boolean {
  return gateReason(name, provided) !== undefined;
}

/** Human-readable reason, preserving the existing GET/POST wire contract. */
export function gateReason(
  name: string,
  provided: ReadonlySet<SurfaceCapability> = webCapabilities(),
): string | undefined {
  const command = lookup(name);
  const deferred = DEFERRED.get(command?.name ?? name);
  if (deferred !== undefined) return deferred;
  // Name fallback keeps boot-time classification safe before registration.
  const missing = missingCapabilities(command ?? { name }, provided);
  return missing.length > 0
    ? `not available on the web: ${missing.map(capabilityReason).join('; ')}`
    : undefined;
}
