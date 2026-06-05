/**
 * Terminal-state parser.
 *
 * AFK's system prompt mandates that every assistant turn end in one of four
 * named terminal states — Done / Blocked / Asking / Interrupted — with a
 * structured set of bullets describing the outcome (per `prompts/system-prompt.md`,
 * §"End-of-turn"). The parser extracts that structure from the trailing
 * portion of the assistant's final text so the REPL can render it as a
 * first-class verdict surface instead of leaving it buried in the markdown
 * stream.
 *
 * Design rules:
 *
 *   - **Conservative.** If we cannot find a clean terminal-state heading at
 *     the tail of the message, return `null`. Better to emit nothing than to
 *     misclassify a chatty turn as terminal.
 *
 *   - **Tail-anchored.** The prompt requires the terminal state to be the
 *     last thing in the turn. We scan the last ~40 lines for the heading;
 *     anything earlier is ignored on purpose.
 *
 *   - **Format-tolerant.** Models drift on bold styling, heading levels,
 *     trailing punctuation, and bullet markers. We accept `**Done**`,
 *     `### Done`, `## Done.`, plain `Done`, and so on, as long as the line is
 *     short and matches the keyword.
 *
 *   - **No invented fields.** We extract only what's literally present.
 *     Missing bullets stay missing — the renderer decides how to handle that.
 *
 * The parser is a pure function: no I/O, no globals, no dependencies on the
 * runtime. It is exercised by `tests/cli/commands/interactive/terminal-state.test.ts`.
 */

/** The four terminal states named in the AFK system prompt. */
export type TerminalKind = 'done' | 'blocked' | 'asking' | 'interrupted';

/**
 * Parsed representation of a terminal-state declaration.
 *
 * Fields mirror the prompt's per-state contracts. They are best-effort — only
 * the fields the model actually emitted will be present. Consumers (e.g.
 * `verdict-card.ts`) must tolerate missing values.
 */
export interface TerminalState {
  kind: TerminalKind;
  /** Done: "What was done". */
  whatWasDone?: string;
  /** Done: "Evidence that exists" / "What changed in the world". */
  evidence?: string;
  /** Done: "Anything still pending or deferred, with why". */
  deferred?: string;
  /** Blocked: "What blocks". */
  whatBlocks?: string;
  /** Blocked: "What must change to unblock". */
  unblockCondition?: string;
  /** Blocked: "What has already been done". */
  alreadyDone?: string;
  /** Asking: the precise question. */
  question?: string;
  /** Asking: "The assumption it resolves". */
  assumption?: string;
  /** Asking: "What you will do once answered". */
  followup?: string;
  /** Interrupted: "What you were doing". */
  whatWasInProgress?: string;
  /** Interrupted: "Where state was saved". */
  stateLocation?: string;
  /** Interrupted: "What resumption requires". */
  resumeRequires?: string;
  /** All non-heading lines under the state header, joined. Useful as a fallback body. */
  rawBody: string;
}

const TAIL_LINES = 40;

/**
 * Attempt to parse a terminal-state declaration from the assistant's final
 * text. Returns `null` when the trailing region does not look like a verdict.
 *
 * The function is tolerant of:
 *   - Bold markers around the state name (`**Done**`, `__Asking__`)
 *   - Markdown headings (`#`, `##`, `###`)
 *   - Trailing punctuation (`Done.`, `Done:`, `Done!`)
 *   - Surrounding whitespace
 *
 * It rejects matches when the keyword appears mid-sentence (e.g. "I'm done
 * with that") by requiring the matching line to be short and to have the
 * keyword as its dominant content.
 */
export function parseTerminalState(text: string): TerminalState | null {
  if (!text) return null;

  const lines = text.split('\n');
  const tail = lines.slice(Math.max(0, lines.length - TAIL_LINES));

  // Walk backward looking for the most recent heading-like line that resolves
  // to a terminal kind. The model's own structure puts it last.
  let headingIdx = -1;
  let kind: TerminalKind | null = null;

  for (let i = tail.length - 1; i >= 0; i--) {
    const line = tail[i] ?? '';
    const k = lineToKind(line);
    if (k) {
      headingIdx = i;
      kind = k;
      break;
    }
  }

  if (kind === null || headingIdx < 0) return null;

  const bodyLines = tail.slice(headingIdx + 1).map((l) => l.trim());
  // Strip leading/trailing blank lines from the captured body.
  while (bodyLines.length > 0 && bodyLines[0] === '') bodyLines.shift();
  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();

  const bullets = extractBullets(bodyLines);
  const rawBody = bodyLines.join('\n').trim();

  return {
    kind,
    rawBody,
    ...mapBulletsToFields(kind, bullets),
  };
}

/**
 * If the line is a short, isolated header naming a terminal state, return
 * that kind. Otherwise null.
 */
function lineToKind(line: string): TerminalKind | null {
  const stripped = line
    .trim()
    // Strip leading markdown heading markers (require trailing whitespace
    // so we don't eat a `#` glued to text — `#tag` is not a heading).
    .replace(/^#{1,6}\s+/, '')
    // Strip a leading bullet glyph followed by required whitespace. The
    // whitespace requirement is load-bearing: without it `**Done**` would
    // see its leading `*` chewed off, breaking the bold-pair stripper below.
    .replace(/^[-•▶▸]\s+/, '')
    .replace(/^\*\s+/, '')
    // Strip surrounding bold/italic markup.
    .replace(/^\*\*(.+?)\*\*$/, '$1')
    .replace(/^__(.+?)__$/, '$1')
    .replace(/^\*(.+?)\*$/, '$1')
    .replace(/^_(.+?)_$/, '$1')
    // Trailing punctuation.
    .replace(/[.:!?\s]+$/, '')
    .trim();

  if (stripped.length === 0 || stripped.length > 24) return null;

  const lower = stripped.toLowerCase();
  if (lower === 'done') return 'done';
  if (lower === 'blocked') return 'blocked';
  if (lower === 'asking') return 'asking';
  if (lower === 'interrupted') return 'interrupted';
  return null;
}

interface Bullet {
  /** Lowercased label before the first colon, or '' if none. */
  label: string;
  /** Trimmed value after the first colon, or the whole line if no colon. */
  value: string;
}

/**
 * Walk the captured body and return a flat list of bullets. Recognizes
 * `- foo: bar`, `* foo`, plain `foo: bar` lines, and unlabelled prose.
 *
 * Multi-line continuations (bullets spanning two lines) are merged into the
 * preceding bullet's value.
 */
function extractBullets(bodyLines: string[]): Bullet[] {
  const out: Bullet[] = [];
  for (const raw of bodyLines) {
    const line = raw.trim();
    if (line === '') continue;

    const bulletMatch = /^(?:[-*•▶▸]|\d+[.)])\s+(.*)$/.exec(line);
    const content = bulletMatch ? (bulletMatch[1] ?? '').trim() : line;

    if (!bulletMatch && out.length > 0 && line.length > 0) {
      // Continuation of the previous bullet.
      const prev = out[out.length - 1]!;
      prev.value = `${prev.value} ${line}`.trim();
      continue;
    }

    const colonIdx = content.indexOf(':');
    if (colonIdx > 0 && colonIdx < 60) {
      const label = content
        .slice(0, colonIdx)
        .trim()
        .replace(/^\*\*(.+?)\*\*$/, '$1')
        .replace(/^__(.+?)__$/, '$1')
        .toLowerCase();
      const value = content.slice(colonIdx + 1).trim();
      out.push({ label, value });
    } else {
      out.push({ label: '', value: content });
    }
  }
  return out;
}

/**
 * Map the bullet list onto the kind-specific TerminalState fields. Lookup is
 * by substring on the lowercased label so minor wording drift ("what blocks"
 * vs "what blocks me") still maps. Unlabelled bullets are ignored here — the
 * renderer falls back to `rawBody` when no labelled bullets matched.
 */
function mapBulletsToFields(
  kind: TerminalKind,
  bullets: Bullet[],
): Partial<TerminalState> {
  const find = (...needles: string[]): string | undefined => {
    for (const b of bullets) {
      if (b.label === '') continue;
      for (const n of needles) {
        if (b.label.includes(n)) return b.value;
      }
    }
    return undefined;
  };

  switch (kind) {
    case 'done': {
      const out: Partial<TerminalState> = {};
      const whatWasDone = find('what was done', 'what i did', 'completed', 'done');
      if (whatWasDone !== undefined) out.whatWasDone = whatWasDone;
      const evidence = find('evidence', 'what changed', 'change', 'artifact', 'output');
      if (evidence !== undefined) out.evidence = evidence;
      const deferred = find('pending', 'deferred', 'follow-up', 'followup', 'next');
      if (deferred !== undefined) out.deferred = deferred;
      return out;
    }
    case 'blocked': {
      const out: Partial<TerminalState> = {};
      const whatBlocks = find('what blocks', 'blocker', 'blocked by');
      if (whatBlocks !== undefined) out.whatBlocks = whatBlocks;
      const unblockCondition = find('unblock', 'must change', 'to unblock', 'condition');
      if (unblockCondition !== undefined) out.unblockCondition = unblockCondition;
      // Needles must cover the literal directive bullet `What has already
      // been done` (Blocked, line 4) as well as common paraphrases. The
      // original `'already done'` and `'what has been done'` both fail
      // String.includes against the directive label — `'already'` sits
      // between `'what has'` and `'been done'`, breaking continuity for
      // both — so `'has already'` and `'been done'` are the ones that
      // actually catch the directive form. The shorter needles are kept
      // for paraphrased model output.
      const alreadyDone = find(
        'has already',
        'been done',
        'already done',
        'what has been done',
        'progress',
      );
      if (alreadyDone !== undefined) out.alreadyDone = alreadyDone;
      return out;
    }
    case 'asking': {
      const out: Partial<TerminalState> = {};
      const question = find('question', 'asking');
      if (question !== undefined) out.question = question;
      const assumption = find('assumption', 'resolves');
      if (assumption !== undefined) out.assumption = assumption;
      const followup =
        find('once answered', 'follow-up', 'next', 'will do', 'after');
      if (followup !== undefined) out.followup = followup;
      return out;
    }
    case 'interrupted': {
      const out: Partial<TerminalState> = {};
      const whatWasInProgress = find('what you were doing', 'in progress', 'doing', 'task');
      if (whatWasInProgress !== undefined) out.whatWasInProgress = whatWasInProgress;
      const stateLocation = find('state was saved', 'state', 'saved', 'where');
      if (stateLocation !== undefined) out.stateLocation = stateLocation;
      const resumeRequires = find('resumption', 'resume', 'requires');
      if (resumeRequires !== undefined) out.resumeRequires = resumeRequires;
      return out;
    }
  }
}
