/**
 * Transport-failure detection for the `audit:deps` CVE gate.
 *
 * Split into its own side-effect-free module so the runner (`audit-deps.ts`,
 * which calls `process.exit`) and the test can both import the predicate without
 * spawning `pnpm audit` or terminating the process.
 *
 * Contract: `isAuditEndpointUnavailable(output)` returns true ONLY when the audit
 * could not be performed for TRANSPORT reasons — the npm audit endpoint is
 * retired/unreachable (HTTP 410, DNS/connection errors), or pnpm's own
 * bad-response guard fired. A genuine critical-advisory finding exits nonzero
 * WITHOUT any of these markers, so it is never matched here and always fails the
 * gate. Keep the marker set narrow and transport-specific — a false positive here
 * would silently swallow a real critical CVE.
 */

/** pnpm/npm markers that mean "the audit endpoint could not be reached", not "a CVE was found". */
const TRANSPORT_FAILURE_MARKERS: readonly RegExp[] = [
  // pnpm's guard when the audit endpoint returns an unexpected response.
  /ERR_PNPM_AUDIT_BAD_RESPONSE/i,
  // npm's 410 retirement notice for the legacy audit endpoints.
  /endpoint is being retired/i,
  /responded with 410/i,
  // Generic network/DNS failures reaching the registry.
  /\bENOTFOUND\b/,
  /\bEAI_AGAIN\b/,
  /\bECONNREFUSED\b/,
  /\bECONNRESET\b/,
  /\bETIMEDOUT\b/,
  /\bfetch failed\b/i,
];

export function isAuditEndpointUnavailable(output: string): boolean {
  return TRANSPORT_FAILURE_MARKERS.some((re) => re.test(output));
}
