/**
 * Preamble detection and user-content extraction for agent session records.
 *
 * Extracted from `src/web-server/session-source.ts` so the replay engine
 * (`afk whatif --verify`) can strip preamble boilerplate from real user turns
 * before replaying them as episode inputs — without depending on the web-server
 * module from within the agent layer.
 *
 * Behavior is byte-identical to the original private functions in session-source.ts.
 * session-source.ts now imports and re-uses these instead of duplicating them.
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
 * boilerplate with no user content. Three strategies, in order:
 *
 *   1. Bridge-tail marker: "Read any referenced file for deeper context before
 *      acting" — everything after that line is user text.
 *   2. XML-tagged skill dispatch (`<command-name>`/`<command-args>` tags).
 *   3. Lines after the last bracketed section header.
 *
 * @module agent/session/preamble-strip
 */

/**
 * Detect plugin/skill preamble text injected as a synthetic first user turn.
 * These start with a bracketed tag like `[agent-workflow-amplifiers: unlocked]`
 * or `[skill-routing: active]`, OR with an XML tag like
 * `<preflight-context ...>` or `<command-name>` from skill dispatch.
 */
export function isPreamble(text: string): boolean {
  return /^\s*(\[[\w-]+[:\s]|<(preflight-context|command-name)\b)/.test(text);
}

/**
 * Extract a readable "/<skill> <args>" title from XML-tagged skill dispatch
 * records. When `summarizeContentBlocks` joins a manifest + breadcrumb +
 * instruction, the ledger record contains `<command-name>` and
 * `<command-args>` tags from the breadcrumb formatter.
 */
export function extractSkillTitle(text: string): string | undefined {
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
    const result = cleaned.trim();
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
    if (/^\s*\[[\w-]+[:\s]/.test(lines[i]!)) lastBracketLine = i;
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
