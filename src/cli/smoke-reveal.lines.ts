/**
 * Line classification for the text reveal: splits streamed raw markdown into
 * runs of "heading line" vs "everything else", carrying line state across
 * chunk boundaries, so the mask can give headings the smoke accent.
 *
 * Contract: `split(chunk)` returns runs whose texts concatenate back to
 * `chunk` exactly. Classification happens at each line start from whatever
 * of that line is in hand. A line start that is still ambiguous at the end of
 * a chunk (`#`, `##` with nothing after) is guessed to be a heading; a wrong
 * guess only changes the reveal style of a couple of syntax characters.
 * Lines inside a fenced code block are never headings (the mask skips code
 * anyway, this just keeps `# comment` lines out of the accent).
 *
 * Extended: the first non-blank line is also treated as a heading when it is
 * a bold-only title (`**text**`, `*text*`). Models frequently respond with a
 * bold title line instead of a `#` heading — without this, the smoke accent
 * never fires for those responses.
 *
 * @module cli/smoke-reveal.lines
 */

export interface LineRun {
  text: string;
  heading: boolean;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const HEADING_RE = /^ {0,3}#{1,6}(\s|$)/;
const PARTIAL_HEADING_RE = /^ {0,3}#{1,6}$/;
/**
 * Bold-only title: the line is entirely `**text**` or `*text*` with optional
 * trailing punctuation/whitespace. Matches when the line STARTS with `**` or
 * `*` so a chunk truncated before the closing `**` is still classified early.
 * The classifier flips heading=false if the line later turns out to be prose.
 */
const BOLD_TITLE_RE = /^\*{1,2}\S/;

export class LineClassifier {
  private atLineStart = true;
  private heading = false;
  private inFence = false;
  /**
   * True until the first non-blank line has been fully classified.
   * Bold-title detection only applies to the first non-blank line so it does
   * not accidentally smoke every bold word in a long response.
   */
  private firstLine = true;

  split(chunk: string): LineRun[] {
    const runs: LineRun[] = [];
    let cur = '';
    let curHeading = this.heading;
    let i = 0;
    while (i < chunk.length) {
      if (this.atLineStart) {
        const nl = chunk.indexOf('\n', i);
        const rest = chunk.slice(i, nl === -1 ? chunk.length : nl);
        this.heading = this.classify(rest, nl === -1);
        this.atLineStart = false;
      }
      const nl = chunk.indexOf('\n', i);
      const end = nl === -1 ? chunk.length : nl + 1;
      if (this.heading !== curHeading && cur) {
        runs.push({ text: cur, heading: curHeading });
        cur = '';
      }
      curHeading = this.heading;
      cur += chunk.slice(i, end);
      if (nl !== -1) {
        this.atLineStart = true;
        // A newline terminates the first line (blank or not). If the current
        // line was blank we stay on firstLine; if it was non-blank we have
        // consumed it. `this.heading` reflects whether the just-completed line
        // was a heading — if it was, we're past the first-line window.
        if (this.heading) this.firstLine = false;
        else if (cur.trim()) this.firstLine = false;
      }
      i = end;
    }
    if (cur) runs.push({ text: cur, heading: curHeading });
    return runs;
  }

  reset(): void {
    this.atLineStart = true;
    this.heading = false;
    this.inFence = false;
    this.firstLine = true;
  }

  private classify(rest: string, truncated: boolean): boolean {
    if (FENCE_RE.test(rest)) {
      this.inFence = !this.inFence;
      return false;
    }
    if (this.inFence) return false;
    if (HEADING_RE.test(rest) || (truncated && PARTIAL_HEADING_RE.test(rest))) return true;
    // Bold-only first line: treat as heading for the smoke accent so a bold
    // title (`**Summary**`) gets the same condensing effect as `# Summary`.
    if (this.firstLine && BOLD_TITLE_RE.test(rest)) return true;
    // A non-blank line that is neither a heading nor a bold title consumed
    // the first-line window — future lines are always classified as prose.
    if (rest.trim()) this.firstLine = false;
    return false;
  }
}
