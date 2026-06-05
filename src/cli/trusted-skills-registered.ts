/**
 * Side-effect module — registers all trusted skills at startup.
 * Imported by slash/index.ts for its registration side effect.
 * No default export.
 */

import { registerTrustedSkill } from './trusted-skill-badge.js';

registerTrustedSkill('shadow-verify', {
  glyph: '◈',
  color: '#7B5EA7',
  inFlightVerb: 'verifying…',
});
