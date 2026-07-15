import { describe, it, expect } from 'vitest';

import { isAuditEndpointUnavailable } from '../scripts/audit-deps-endpoint.js';

describe('audit:deps — isAuditEndpointUnavailable', () => {
  it('tolerates the npm 410 endpoint-retirement failure (the reason for this wrapper)', () => {
    const out =
      ' ERR_PNPM_AUDIT_BAD_RESPONSE  The audit endpoint (at ' +
      'https://registry.npmjs.org/-/npm/v1/security/audits/quick) responded with 410: ' +
      '{"error":"This endpoint is being retired. Use the bulk advisory endpoint instead."}';
    expect(isAuditEndpointUnavailable(out)).toBe(true);
  });

  it('tolerates DNS / connection failures reaching the registry', () => {
    for (const marker of ['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT']) {
      expect(isAuditEndpointUnavailable(`request to registry failed: ${marker} registry.npmjs.org`)).toBe(
        true,
      );
    }
    expect(isAuditEndpointUnavailable('TypeError: fetch failed')).toBe(true);
  });

  it('does NOT tolerate a genuine critical advisory report (the gate must still fail)', () => {
    // Representative pnpm-audit output when a critical advisory IS found. It never
    // contains a transport-failure marker, so the wrapper must propagate the failure.
    const out = [
      '┌─────────────────────┬────────────────────────────────────────────────────────┐',
      '│ critical            │ Prototype Pollution in some-prod-dep                   │',
      '│ Package             │ some-prod-dep                                          │',
      '│ Vulnerable versions │ <4.17.20                                               │',
      '│ Patched versions    │ >=4.17.20                                              │',
      '│ More info           │ https://github.com/advisories/GHSA-xxxx-xxxx-xxxx      │',
      '└─────────────────────┴────────────────────────────────────────────────────────┘',
      '1 vulnerabilities found. Severity: 1 critical',
    ].join('\n');
    expect(isAuditEndpointUnavailable(out)).toBe(false);
  });

  it('does NOT tolerate a clean / empty result', () => {
    expect(isAuditEndpointUnavailable('')).toBe(false);
    expect(isAuditEndpointUnavailable('No known vulnerabilities found')).toBe(false);
  });
});
