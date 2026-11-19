/** Terminal-row boundary: only printable text, line breaks, tabs and SGR survive. */

// Consume whole sequences before bare controls, so cursor commands and OSC/DCS
// payloads cannot become visible text. Include ESC intermediates (e.g. charset
// selection) as well as CSI and string controls, in both 7-bit and C1 forms.
// eslint-disable-next-line no-control-regex
const FRAME_CONTROLS = /(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)|(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)|(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]|[\x00-\x1f\x7f-\x9f]/g;
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
