/**
 * REPL-backed elicitation handler factory.
 *
 * History: extracted verbatim from `elicitation-repl.ts` (#367). Prompts the
 * interactive user on stdin when an MCP server requests an elicitation
 * (OAuth URL consent or structured form fields) or the agent asks a
 * question. The handler is structured as a factory so tests can inject a
 * stubbed `readLine` and `writer` in place of real stdin. Routes to the
 * mode modules: `agent-question.ts`, `form-mode.ts`, `url-mode.ts`.
 */

import type { ElicitationRequest, ElicitationResult } from '../../agent/types/sdk-types.js';
import { debugLog } from '../../utils/debug.js';
import { ringBellIfEnabled } from '../_lib/capture-mode.js';
import { sanitizeSchemaString } from '../_lib/sanitize.js';
import { palette } from '../palette.js';
import type { ReplElicitationDeps } from './repl-shared.js';
import { DECLINE, CANCEL, ACCEPT } from './repl-shared.js';
import type { FieldDef } from './form-mode.js';
import {
  MAX_FIELDS,
  BLOCKED_KEYS,
  parseProperties,
  renderFormHeader,
  promptField,
} from './form-mode.js';
import { renderUrlRequest } from './url-mode.js';
import { renderAgentQuestion } from './agent-question.js';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function makeReplElicitationHandler(
  deps: ReplElicitationDeps,
): (request: ElicitationRequest, options: { signal: AbortSignal }) => Promise<ElicitationResult> {
  return async (request, { signal }) => {
    if (signal.aborted) return DECLINE;

    // Ring the terminal bell when an elicitation begins — the agent needs
    // input (AFK_BELL=1, TTY-only). No-op otherwise. Fires before the
    // suspend/agent-origin split so it covers every elicitation path.
    ringBellIfEnabled(process.stdout);

    // Invariant: suspendInput MUST wrap the ENTIRE handler — not just per-
    // readLine — because:
    //   1. `writer.line(...)` header writes (server name, message, "Type
    //      :cancel...") go to raw stdout BEFORE the first readLine. While the
    //      compositor is still active, the 80ms spinner ticker repaints over
    //      them on the next tick (see terminal-compositor.ts tickSpinner →
    //      repaint, gated on `suspended`).
    //   2. Arrow-key selectors (renderSelector / renderMultiSelector) own
    //      their own raw mode and keypress listener; while they're active,
    //      the compositor's overlay must stay quiescent.
    //   3. Number/text re-prompt loops emit warnings via writer.line between
    //      readLine calls — these would land in a contested overlay region
    //      if suspend were per-readLine only.
    // The compositor's suspendInput/resumeInput are idempotent and no-ops
    // when not armed (non-TTY surfaces, unit tests), so wrapping at the
    // outer scope is safe across all surfaces.
    deps.suspendInput?.();
    try {
      // Agent-originated ask_question requests take a dedicated path
      if (request.origin === 'agent') {
        return await renderAgentQuestion(request, deps, signal);
      }

      if (request.mode === 'form') {
        const schema = request.requestedSchema;
        const { properties, required, fieldsTruncated, originalFieldCount } =
          typeof schema === 'object' && schema !== null
            ? parseProperties(schema)
            : {
                properties: {} as Record<string, FieldDef>,
                required: new Set<string>(),
                fieldsTruncated: false,
                originalFieldCount: 0,
              };

        renderFormHeader(deps.writer, request);
        // M-5: surface the silent MAX_FIELDS truncation so a user looking at a
        // partial form can tell the schema was capped (vs. genuinely sparse).
        if (fieldsTruncated) {
          deps.writer.line(
            palette.warning(
              `  ⚠ Schema has ${originalFieldCount} fields; only the first ${MAX_FIELDS} will be prompted (server may be malformed or compromised).`,
            ),
          );
        }

        // Create content WITHOUT Object.prototype so that even if a blocked
        // key slips past parseProperties (defence-in-depth), assigning to it
        // cannot pollute the global prototype chain.
        const content: Record<string, unknown> = Object.create(null);

        if (Object.keys(properties).length === 0) {
          // Malformed / absent schema. The v1 fallback invented an undocumented
          // `response` key with `action: 'accept'`, which neither the MCP spec
          // recognises nor the v1 URL-mode contract honours. Decline instead —
          // safer, idempotent, and prompts the server to surface its error.
          deps.writer.line(
            palette.warning('  ⚠ Form schema has no usable fields — declining.'),
          );
          return DECLINE;
        }

        // Cross-validate: a required key absent from properties is unresolvable.
        // Without this guard, the accept payload would silently omit the key
        // and the server would reject the response with no client diagnostic.
        for (const key of required) {
          if (!(key in properties)) {
            deps.writer.line(
              palette.warning(
                `  ⚠ Required field '${sanitizeSchemaString(key, 64)}' has no schema entry — declining.`,
              ),
            );
            return DECLINE;
          }
        }

        for (const [fieldKey, fieldDef] of Object.entries(properties)) {
          // M-3b: catch abort fired in the microtask gap between iterations
          // before re-entering promptField — defence-in-depth with the inner
          // top-of-function check.
          if (signal.aborted) return CANCEL;
          const outcome = await promptField(
            fieldKey,
            fieldDef,
            required.has(fieldKey),
            deps.readLine,
            deps.writer,
            signal,
            deps.pickFromList,
          );
          if (outcome.tag === 'cancel') return CANCEL;
          if (outcome.tag === 'decline') return DECLINE;
          if (outcome.value !== undefined && !BLOCKED_KEYS.has(fieldKey)) {
            content[fieldKey] = outcome.value;
          }
        }

        // Strip the null prototype before returning so downstream JSON
        // serialisation and consumers expecting a normal POJO behave correctly.
        return { action: 'accept', content: { ...content } };
      }

      // URL mode (also the default when mode is omitted — most MCP OAuth
      // flows surface a URL to visit).
      renderUrlRequest(deps.writer, request);
      // Invariant: every readLine/pickFromList await in this module maps a
      // rejection (Ctrl+C, session teardown mid-prompt) to CANCEL — this was
      // previously the ONLY such await left unguarded, so a rejection here
      // propagated past this handler's `finally` and was reinterpreted as
      // DECLINE by the router's outer `.catch(() => DECLINE)`
      // (elicitation-router.ts) instead of CANCEL. DECLINE and CANCEL are
      // different signals to the MCP server; an interrupted prompt must
      // report the same outcome every other path already does.
      let reply: string;
      try {
        reply = (await deps.readLine(palette.dim('Continue? [y/N] '))).trim().toLowerCase();
      } catch (err) {
        debugLog('[elicitation] url-mode readLine failed:', err);
        return CANCEL;
      }
      if (reply === '') return CANCEL;
      if (reply === 'y' || reply === 'yes') return ACCEPT;
      return DECLINE;
    } finally {
      // Resume MUST fire on every exit path — including thrown errors and
      // early returns — or the compositor stays frozen and the next user
      // interaction sees a dead screen.
      deps.resumeInput?.();
    }
  };
}
