/**
 * Telegram-backed elicitation handler.
 *
 * Routes MCP elicitations + path-approval prompts to the Telegram chat with
 * an inline keyboard. Resolves the `ElicitationResult` promise when the user
 * taps a button.
 *
 * # Wire format
 *
 * Inline buttons carry `callback_data` of the form
 *
 *   `afk:pa:<ulid>:<choice>`
 *
 * where `<ulid>` uniquely identifies the elicitation request and `<choice>`
 * is the enum value (e.g. `once` / `session` / `persist` / `deny`).
 * The ULID prefix is mandatory so two elicitations fired in the same chat
 * (e.g. by concurrent subagents) don't have their callbacks aliased.
 *
 * Invariant: this prefix (`afk:pa:`) is deliberately DISJOINT from the
 * `ask_question` handler's `afk:e:<digit>:<id>` format (see
 * `elicitation-callback-data.ts`). Both handlers register a `bot.action` on
 * the same Telegraf instance; disjoint prefixes guarantee a tap routes to
 * exactly one handler. Sharing a prefix (the pre-fix bug) made the broader
 * `^afk:e:` matcher swallow ask_question taps and reply "no longer active".
 *
 * # Threat model
 *
 * Allowlist guarding is the bot's middleware concern (every chat ID in
 * `AFK_TELEGRAM_ALLOWED_CHAT_IDS` is trusted). By the time a callback
 * reaches us we know the tap came from the user. We still
 * defensively dispatch by the in-process pending-request map — an out-of-
 * band callback (e.g. a copied URL pasted manually) hits a request that
 * has already resolved and gets a "stale" reply.
 *
 * # Lifecycle
 *
 * Each elicitation request:
 *   1. Generates a fresh ULID and stores `{ resolve, enumValues }` in a
 *      module-scope Map keyed by ULID.
 *   2. Sends the message + inline keyboard to every allowlisted chat ID.
 *   3. Awaits the first callback that matches the ULID.
 *   4. Calls `ctx.answerCbQuery()` and resolves the promise.
 *   5. The pending entry is GC'd when EITHER the callback resolves it OR the
 *      request's AbortSignal fires (session/turn teardown). The elicitation
 *      router has NO time-based deadline — the prior 5-minute ceiling was
 *      removed (it cut off operators who stepped away), so abort is the only
 *      non-resolution cleanup path.
 *
 * @module telegram/elicitation-telegram
 */

import type { Telegraf, Context } from 'telegraf';
import type { InlineKeyboardMarkup } from 'telegraf/types';
import { generateUlid } from '../agent/permissions-store.js';
import type {
  ElicitationHandler,
} from '../agent/elicitation-router.js';
import type {
  ElicitationRequest,
  ElicitationResult,
} from '../agent/types/sdk-types.js';

/**
 * Prefix for path-approval / MCP elicitation callbacks. DISTINCT from the
 * `ask_question` handler's `afk:e:` prefix (`elicitation-callback-data.ts`)
 * so the two `bot.action` matchers never cross-route — see the module header.
 */
export const ELICITATION_CALLBACK_PREFIX = 'afk:pa:';

/** Maximum bytes for inline-keyboard callback_data (Telegram limit is 64). */
const MAX_CALLBACK_DATA_BYTES = 64;

interface PendingElicitation {
  resolve: (result: ElicitationResult) => void;
  enumValues: string[];
}

/**
 * Module-scope pending-request map. Keyed by the ULID embedded in each
 * callback_data. Lives at module scope (not per-bot) so the singleton
 * `elicitationRouter.install(...)` can register a handler that closes over
 * it without needing to thread state through every call site.
 */
const pending = new Map<string, PendingElicitation>();

/**
 * Install a callback handler on the Telegraf instance that resolves
 * elicitation buttons. Must be called BEFORE `bot.launch()` so the action
 * regex is registered ahead of the first incoming update.
 *
 * Returns an `ElicitationHandler` that callers pass to
 * `elicitationRouter.install(...)`.
 */
export function createTelegramElicitationHandler(
  bot: Telegraf,
  chatIds: Set<number>,
  log: (...args: unknown[]) => void = () => {},
): ElicitationHandler {
  // Register the action handler exactly once per bot. Bots in tests may
  // reuse the same Telegraf instance across handler factories; guard
  // against double-registration by stashing a flag on the bot object.
  // (`as { _elicitationRegistered?: boolean }` because Telegraf is plain JS
  // and accepts ad-hoc property assignment.)
  const botAny = bot as Telegraf & { _elicitationRegistered?: boolean };
  if (!botAny._elicitationRegistered) {
    const actionRe = new RegExp(`^${escapeRegExp(ELICITATION_CALLBACK_PREFIX)}`);
    bot.action(actionRe, async (ctx) => handleElicitationCallback(ctx, log));
    botAny._elicitationRegistered = true;
  }

  return async (request, options) => {
    if (options.signal.aborted) {
      return { action: 'decline' };
    }
    return new Promise<ElicitationResult>((resolve) => {
      const ulid = generateUlid();
      const enumValues = extractEnumValues(request);
      pending.set(ulid, {
        resolve,
        enumValues,
      });

      const text = formatRequest(request);
      const keyboard = buildKeyboard(ulid, enumValues);

      // Send to every allowlisted chat. The first callback resolves; later
      // taps from other chats hit the "stale" path.
      const sends = Array.from(chatIds).map(async (chatId) => {
        try {
          await bot.telegram.sendMessage(chatId, text, {
            reply_markup: keyboard,
          });
        } catch (err) {
          log('[elicitation] sendMessage failed:', err);
        }
      });
      // Fire-and-forget: we don't await the sends. If they all fail, the
      // promise stays pending until the request's AbortSignal fires (session/
      // turn teardown) and the abort listener below resolves DECLINE + GCs the
      // entry. The router has no time-based deadline, so abort is the cleanup
      // path. Acceptable degraded behavior.
      void Promise.all(sends);

      // Abort wiring — if the outer signal fires (e.g. session torn down),
      // we resolve as decline and GC the pending entry.
      options.signal.addEventListener(
        'abort',
        () => {
          const entry = pending.get(ulid);
          if (!entry) return;
          pending.delete(ulid);
          entry.resolve({ action: 'decline' });
        },
        { once: true },
      );
    });
  };
}

async function handleElicitationCallback(
  ctx: Context,
  log: (...args: unknown[]) => void,
): Promise<void> {
  // Telegraf threads the callback_data on `ctx.callbackQuery.data`.
  const cb = (ctx.callbackQuery as { data?: string } | undefined)?.data;
  if (typeof cb !== 'string' || !cb.startsWith(ELICITATION_CALLBACK_PREFIX)) {
    await ctx.answerCbQuery('Unknown callback').catch(() => {});
    return;
  }
  const tail = cb.slice(ELICITATION_CALLBACK_PREFIX.length);
  const sepIdx = tail.indexOf(':');
  if (sepIdx <= 0 || sepIdx === tail.length - 1) {
    await ctx.answerCbQuery('Malformed callback').catch(() => {});
    return;
  }
  const ulid = tail.slice(0, sepIdx);
  const choice = tail.slice(sepIdx + 1);

  const entry = pending.get(ulid);
  if (!entry) {
    // Stale or never-existed — most often a duplicate tap after the first
    // resolved, or a tap on a prompt whose request was aborted (session/turn
    // teardown GC'd the entry). Answer the spinner so the user UI doesn't hang.
    await ctx.answerCbQuery('This prompt is no longer active.').catch(() => {});
    return;
  }
  if (!entry.enumValues.includes(choice)) {
    log('[elicitation] callback choice not in enum:', choice, entry.enumValues);
    await ctx.answerCbQuery('Unknown choice').catch(() => {});
    return;
  }

  // Resolve the pending promise. Per the MCP elicitation spec, accept
  // carries `content` keyed by the schema property — we use 'choice' as a
  // stable convention since path-approval emits a single enum field.
  pending.delete(ulid);
  entry.resolve({
    action: 'accept',
    content: { choice },
  });

  // Acknowledge the button tap so Telegram clears the spinner. The button
  // ack message is what the user sees as a brief toast.
  await ctx.answerCbQuery(`Recorded: ${choice}`).catch((err: unknown) => {
    log('[elicitation] answerCbQuery failed:', err);
  });
}

/**
 * Pull the `enum` array off the requestedSchema's first property. For path
 * approval this is `['once', 'session', 'persist', 'deny']`. Falls back to
 * accept/decline for non-form requests (URL mode).
 */
function extractEnumValues(req: ElicitationRequest): string[] {
  if (req.mode !== 'form') return ['accept', 'decline'];
  const schema = req.requestedSchema;
  if (typeof schema !== 'object' || schema === null) return ['accept', 'decline'];
  const props = (schema as Record<string, unknown>)['properties'];
  if (typeof props !== 'object' || props === null) return ['accept', 'decline'];
  const firstKey = Object.keys(props as Record<string, unknown>)[0];
  if (firstKey === undefined) return ['accept', 'decline'];
  const field = (props as Record<string, unknown>)[firstKey];
  if (typeof field !== 'object' || field === null) return ['accept', 'decline'];
  const enumArr = (field as Record<string, unknown>)['enum'];
  if (!Array.isArray(enumArr)) return ['accept', 'decline'];
  return enumArr.map(String);
}

function formatRequest(req: ElicitationRequest): string {
  const parts: string[] = [];
  // Plain text — `sendMessage` is sent without `parse_mode`, so Markdown
  // syntax would render literally. The body carries filesystem paths
  // (underscores, brackets) that would also break a Markdown/HTML parser, so
  // emitting plain text is the correct (and safe) choice here.
  if (req.title) parts.push(req.title);
  parts.push(req.message);
  // Telegram has a 4096-char body limit. Truncate defensively (path strings
  // can be long; we don't want to fail-silent on send).
  const joined = parts.join('\n\n');
  return joined.length > 4000 ? joined.slice(0, 3997) + '...' : joined;
}

function buildKeyboard(ulid: string, choices: string[]): InlineKeyboardMarkup {
  // Truncate any choice that would exceed the 64-byte callback_data ceiling
  // once the prefix + ulid + separator are included. ULID is 26 bytes
  // + 'afk:pa:' (7 bytes) + ':' (1 byte) = 34 bytes of overhead, leaving
  // 30 bytes for the choice — comfortable for the path-approval enums.
  const overhead = ELICITATION_CALLBACK_PREFIX.length + ulid.length + 1;
  const room = MAX_CALLBACK_DATA_BYTES - overhead;
  const buttons = choices.map((choice) => {
    const safe = choice.length <= room ? choice : choice.slice(0, room);
    return {
      text: labelFor(safe),
      callback_data: `${ELICITATION_CALLBACK_PREFIX}${ulid}:${safe}`,
    };
  });

  // Layout: 2x2 if 4 buttons (path approval), single column otherwise.
  if (buttons.length === 4) {
    return {
      inline_keyboard: [
        [buttons[0]!, buttons[1]!],
        [buttons[2]!, buttons[3]!],
      ],
    };
  }
  return { inline_keyboard: buttons.map((b) => [b]) };
}

/**
 * Human-friendly labels for known enum values. Falls through to title-case
 * for unknowns (so future enums get a reasonable default rendering).
 */
function labelFor(choice: string): string {
  switch (choice) {
    case 'once':
      return '✅ Once';
    case 'session':
      return '🔁 Session';
    case 'persist':
      return '💾 Always';
    case 'deny':
      return '❌ Deny';
    case 'accept':
      return '✅ Accept';
    case 'decline':
      return '❌ Decline';
    default:
      return choice.charAt(0).toUpperCase() + choice.slice(1);
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compose the two Telegram elicitation handlers into ONE dispatcher for
 * `elicitationRouter.install`. Routes by request kind:
 *   - `request.type` set → agent-originated `ask_question` (confirm / choice /
 *     text / number / multi_choice) → `askHandler` (the `afk:e:` handler in
 *     `elicitation-handler.ts`: inline buttons + typed replies).
 *   - otherwise (`mode:'form'|'url'`, no `type`) → path-approval / MCP
 *     elicitation → `formHandler` (this module's `afk:pa:` enum keyboard).
 *
 * Invariant: install the COMPOSED handler exactly once. `elicitationRouter
 * .install` is last-wins (`this.handler = handler`), so installing the two
 * handlers separately silently clobbers the first — the PR #477 bug this
 * fixes (the path-approval install was overwritten by the ask_question install
 * inside `bot.start()`). Both underlying factories still register their own
 * disjoint `bot.action` (`afk:e:<digit>:` vs `afk:pa:`), so button taps never
 * cross-route. `request.type` is the discriminant because `ask_question`
 * always sets it (ask-question.ts) and form/url elicitations never do.
 */
export function composeTelegramElicitation(
  askHandler: ElicitationHandler,
  formHandler: ElicitationHandler,
): ElicitationHandler {
  return (request, options) =>
    request.type !== undefined
      ? askHandler(request, options)
      : formHandler(request, options);
}

/**
 * Test-only: clear the pending map. Production never needs this — entries
 * are GC'd via resolve() or abort, never leaked.
 */
export function _resetPendingForTests(): void {
  pending.clear();
}
