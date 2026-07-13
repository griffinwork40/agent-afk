/**
 * URL-mode elicitation rendering.
 *
 * History: extracted verbatim from `elicitation-repl.ts` (#367).
 *
 * URL mode UX:
 *   1. Print a header line naming the MCP server.
 *   2. Print the message.
 *   3. Print the clickable URL.
 *   4. Prompt "Continue? [y/N]" and wait for stdin.
 *   5. Map y → accept, n → decline, empty → cancel.
 */

import type { ElicitationRequest } from '../../agent/types/sdk-types.js';
import { sanitizeSchemaString } from '../_lib/sanitize.js';
import { palette } from '../palette.js';
import type { ReplElicitationDeps } from './repl-shared.js';

// ---------------------------------------------------------------------------
// URL-mode helper
// ---------------------------------------------------------------------------

export function renderUrlRequest(
  writer: ReplElicitationDeps['writer'],
  req: ElicitationRequest,
): void {
  // Sanitise envelope strings — serverName, message, url, elicitationId are
  // all MCP-controlled and flow directly into terminal output. H-1.
  writer.line();
  writer.line(palette.warning('⚠ MCP elicitation'));
  writer.line(palette.dim('  server:  ') + palette.bold(sanitizeSchemaString(req.serverName, 64)));
  writer.line(palette.dim('  message: ') + sanitizeSchemaString(req.message, 256));
  if (req.url) {
    writer.line(palette.dim('  url:     ') + palette.brand(sanitizeSchemaString(req.url, 512)));
  }
  if (req.elicitationId) {
    writer.line(palette.dim('  id:      ') + sanitizeSchemaString(req.elicitationId, 64));
  }
  writer.line();
}
