/** Terminal-row boundary: only printable text, line breaks, tabs and SGR survive. */

// Consume whole sequences before bare controls so cursor commands and OSC/DCS
// payloads cannot become visible text. Covers ESC intermediates, CSI, and all
// string-introducer controls in both 7-bit and C1 forms.
//
// Unterminated-string row-boundary invariant: each string-introducer arm uses
// [^\n]*? so the match stops at the row boundary. The (?=\n) lookahead in each
// terminator group matches at a newline without consuming it; the callback then
// returns the newline verbatim, keeping subsequent rows intact.
// eslint-disable-next-line no-control-regex
const FRAME_CONTROLS = /(?:\x1b\]|\x9d)[^\n]*?(?:\x07|\x1b\\|\x9c|(?=\n)|$)|(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[^\n]*?(?:\x1b\\|\x9c|(?=\n)|$)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]|[\x00-\x1f\x7f-\x9f]/g;
// Only standard SGR parameters are safe: private/intermediate CSI forms are not
// styles. Colon-separated colour parameters are allowed alongside semicolons.
// eslint-disable-next-line no-control-regex
const SGR = /^(?:\x1b\[|\x9b)[0-9;:]*m$/;

export function sanitizeFrameContent(content: string): string {
  return content.replace(FRAME_CONTROLS, (sequence) => {
    if (sequence === '\n' || sequence === '\t') return sequence;
    // Normalize C1 SGR to the 7-bit form understood by the wrapping layer.
    if (SGR.test(sequence)) return sequence.replace('\x9b', '\x1b[');
    return '';
  });
}
