/**
 * Preamble detection and user-content extraction for agent session records.
 *
 * Extracted from `src/web-server/session-source.ts` so the replay engine
 * (`afk whatif --verify`) can strip preamble boilerplate from real user turns
 * before replaying them as episode inputs — without depending on the web-server
 * module from within the agent layer.
 *
 * session-source.ts imports and re-uses these instead of duplicating them.
 *
 * ## What is a preamble?
 *
 * The harness concatenates the plugin preamble, bridge context, memory hints,
 * and the real user message into a single `user` ledger record. Records that
 * begin with a bracketed tag (e.g. `[agent-workflow-amplifiers: unlocked]`,
 * `[skill-routing: active]`) or an XML tag (`<preflight-context ...>`,
 * `<command-name>`) are preambles. The function `isPreamble()` detects them.
 *
 * `extractUserContent()` peels the known boilerplate sections and returns
 * whatever the user actually typed, or `undefined` when the record is pure
 * boilerplate with no user content. Strategies, in order:
 *
 *   0. Harness envelope: a record that opens with the exact token
 *      `<framework-context>` is cut through the first `</framework-context>`
 *      (see framework-context-envelope.ts). The remainder loses only a switch
 *      notice, a preflight manifest and a skill breadcrumb; the strategies
 *      below never run on it. They serve older records and are kept
 *      byte-identical for them.
 *
 * Rule B: an envelope can exist only in text recorded after the drain
 * (journal, provider history, ledger `text`). Text recorded before it (ledger
 * `input`, session sidecar turns, the caller's own content) goes through the
 * `PreDrain` variants, which never apply strategy 0.
 *   1. Bridge-tail marker: "Read any referenced file for deeper context before
 *      acting" — everything after that line is user text.
 *   2. XML-tagged skill dispatch (`<command-name>`/`<command-args>` tags).
 *   3. Lines after the last bracketed section header.
 *
 * @module agent/session/preamble-strip
 */

import { textAfterFrameworkContext } from './framework-context-envelope.js';
import { peelSwitchNotice } from './model-switch-notice.js';

/** Legacy opener shapes: bracketed or XML tags, never the harness envelope. */
const LEGACY_PREAMBLE_RE = /^\s*(\[[\w-]+[:\s]|\[[a-z][a-z0-9]*(?:-[a-z0-9]+)+\]|<(preflight-context|command-name)\b)/;

/**
 * Detect plugin/skill preamble text injected as a synthetic first user turn.
 * These start with a bracketed tag like `[agent-workflow-amplifiers: unlocked]`
 * or `[skill-routing: active]`, OR with an XML tag like
 * `<preflight-context ...>` or `<command-name>` from skill dispatch, or with
 * the exact harness `<framework-context>` token. Use only on text recorded
 * after the drain; see {@link isPreDrainPreamble}.
 */
export function isPreamble(text: string): boolean {
  return isPreDrainPreamble(text) || textAfterFrameworkContext(text) !== undefined;
}

/**
 * {@link isPreamble} for text recorded BEFORE the drain (the caller's own
 * message): no harness envelope can exist there, so a leading tag is typed.
 */
export function isPreDrainPreamble(text: string): boolean {
  // The kebab-case `[label]` arm covers bare tags with no colon or space,
  // e.g. `[placeholder-prevent]`, which leads every first turn since the
  // placeholder-prevent SessionStart hook landed. It requires a hyphen so a
  // human-typed `[note]` is not mistaken for a preamble.
  return LEGACY_PREAMBLE_RE.test(text);
}

/**
 * Peel a jev rules digest that leads `text`. The jev plugin's SessionStart
 * digest is drained AFTER the bridge block, so it sits between the bridge-tail
 * marker and the user's message. Its body is arbitrary rule prose, so the only
 * reliable boundary is its fixed footer: either the "rule(s) loaded" sentence
 * or, when the digest was capped, the "... (truncated)" line.
 */
function stripLeadingRulesDigest(text: string): string {
  return text.replace(
    /^\s*\[jev rules\][\s\S]*?(?:rule\(s\) loaded\.[^\n]*?will be blocked\.|\n[ \t]*\.\.\. \(truncated\))/,
    '',
  );
}

/**
 * Extract a readable "/<skill> <args>" title from XML-tagged skill dispatch
 * records. When `summarizeContentBlocks` joins a manifest + breadcrumb +
 * instruction, the ledger record contains `<command-name>` and
 * `<command-args>` tags from the breadcrumb formatter.
 */
function extractSkillTitle(text: string): string | undefined {
  const skillMatch = text.match(/<command-name>\/?([^<]+)<\/command-name>/);
  if (!skillMatch) return undefined;
  const skillName = skillMatch[1]!.replace(/^\//, '').trim();
  const argsMatch = text.match(/<command-args>([^<]*)<\/command-args>/);
  const args = argsMatch?.[1]?.trim();
  return args ? `/${skillName} ${args}` : `/${skillName}`;
}

/**
 * Extract user-authored content from a ledger record whose text begins with
 * plugin/bridge preamble.
 *
 * History: the harness concatenates the plugin preamble, bridge context, memory
 * hints, and the real user message into a single `user` record. The old code
 * skipped the whole record on `isPreamble()`, leaving every plugin session
 * untitled in the dashboard. This function peels known boilerplate sections
 * and returns whatever the user actually typed, or `undefined` when the record
 * is pure boilerplate with no user content.
 *
 * Invariant: the bridge section always ends with a recognizable tail marker
 * ("Read any referenced file for deeper context before acting"). User content
 * appears either on the same line (after the marker's trailing punctuation)
 * or on subsequent lines. When no bridge marker is present, fall back to
 * collecting lines after the last bracketed section header.
 */
export function extractUserContent(text: string): string | undefined {
  // Strategy 0: the harness envelope marks the boundary explicitly. Exactly
  // one envelope is peeled, so a later envelope stays user text. The rest is
  // read by extractRemainderUserContent alone (Rule C), never by the legacy
  // strategies: a Telegram `[in reply to ...] question` stays whole.
  const afterEnvelope = textAfterFrameworkContext(text);
  if (afterEnvelope === undefined) return extractPreDrainUserContent(text);
  return afterEnvelope ? extractRemainderUserContent(afterEnvelope) : undefined;
}

/**
 * Read the text after one harness envelope. Hook context is always queued, so
 * only harness shapes with an exact frame can precede the caller's text: the
 * router's switch notice, one complete preflight manifest, and a skill
 * breadcrumb (rendered as "/<skill> <args>"). Everything else is returned
 * whole; the legacy bridge-marker and bracket-header strategies never run.
 */
function extractRemainderUserContent(rest: string): string | undefined {
  let text = peelSwitchNotice(rest.trim()).trim();
  const manifest = /^<preflight-context\b[^>]*>[\s\S]*?<\/preflight-context>/.exec(text);
  if (manifest) text = text.slice(manifest[0].length).trim();
  if (text.startsWith('<command-name>')) return extractSkillTitle(text) ?? text;
  return text || undefined;
}

/**
 * {@link extractUserContent} for text recorded BEFORE the drain: the legacy
 * strategies 1 to 3 only, never the envelope cut.
 */
export function extractPreDrainUserContent(text: string): string | undefined {
  // Strategy 1: find the bridge-tail marker and take everything after it.
  // The user message is appended either on the same line (after "not full
  // content.") or on the lines that follow.
  const bridgeMarker = 'Read any referenced file for deeper context before acting';
  const markerIdx = text.lastIndexOf(bridgeMarker);
  if (markerIdx >= 0) {
    // Skip past the marker line's known suffixes (punctuation variants).
    const afterMarker = text.slice(markerIdx + bridgeMarker.length);
    // Strip the rest of the marker line's boilerplate tail, e.g.
    // " — these are pointers, not full content." before user text.
    const cleaned = afterMarker.replace(
      /^[^.]*\.\s*/,
      '',
    );
    const result = stripLeadingRulesDigest(cleaned).trim();
    // A skill dispatch typed after the preamble surfaces as raw XML tags;
    // render it as "/<skill> <args>" rather than tag soup.
    if (result.startsWith('<command-name>')) return extractSkillTitle(result) ?? result;
    // When the bridge-tail extraction yields user content, return it.
    // When it yields nothing, the bridge marker was present but no user text
    // followed — fall through to the XML-tag strategy only, since the bridge
    // marker is authoritative evidence that everything before it is boilerplate.
    if (result) return result;
    // Bridge marker found but no user content after it — try XML tags only.
    const xmlFallback = extractSkillTitle(text);
    return xmlFallback;
  }

  // Strategy 2: XML-tagged skill dispatch records.
  const xmlTitle = extractSkillTitle(text);
  if (xmlTitle) return xmlTitle;

  // Strategy 3 (no bridge marker, no XML tags): collect lines after the last
  // bracketed section header. Handles minimal preambles like
  // "[skill-routing: active]\n…"
  const lines = text.split('\n');
  let lastBracketLine = -1;
  for (let i = 0; i < lines.length; i++) {
    // Same two header shapes isPreamble() accepts: `[label: …` / `[label …`
    // and a bare kebab tag such as `[placeholder-prevent] …`, whose body sits
    // on the header line itself.
    if (/^\s*(\[[\w-]+[:\s]|\[[a-z][a-z0-9]*(?:-[a-z0-9]+)+\])/.test(lines[i]!)) lastBracketLine = i;
  }
  if (lastBracketLine < 0) return undefined;

  // Take everything after the last bracketed header, skipping the header's
  // own body (indented/bulleted continuation lines).
  const tail: string[] = [];
  let pastBody = false;
  for (let i = lastBracketLine + 1; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!pastBody) {
      // Skip blank lines and lines that look like preamble body (bullets,
      // indented text, known boilerplate starters).
      if (!trimmed || /^[-*]/.test(trimmed)) continue;
      if (/^\[[\w-]+[:\s]/.test(trimmed)) continue;
      pastBody = true;
    }
    tail.push(line);
  }

  const result = tail.join('\n').trim();
  if (!result || /^\s*\[[\w-]+[:\s]/.test(result)) return undefined;
  return result;
}

/**
 * What the user typed in a history message: the text minus any framework
 * preamble drained in front of it, or the text unchanged when it has none or
 * nothing user-authored survives the strip.
 */
export function stripPreamble(text: string): string {
  const afterEnvelope = textAfterFrameworkContext(text);
  if (afterEnvelope === undefined) return stripPreDrainPreamble(text);
  return (afterEnvelope && extractRemainderUserContent(afterEnvelope)) || text;
}

/** {@link stripPreamble} for text recorded BEFORE the drain. */
export function stripPreDrainPreamble(text: string): string {
  return isPreDrainPreamble(text) ? (extractPreDrainUserContent(text) ?? text) : text;
}
