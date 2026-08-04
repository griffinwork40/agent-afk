/** Matches a hand-rolled SGR escape literal and captures its numeric parameters. */
export const RAW_SGR_RE = /\\(?:x1[bB]|u001[bB]|u\{0*1[bB]\}|e|033)\[([0-9;]*)m/g;

/**
 * Contract: return true only for SGR parameters that open a visible style.
 * Reset and style-closing codes remain exempt because they do not bypass the
 * semantic palette by introducing a tone or attribute of their own.
 */
export function isStylingSgr(params: string): boolean {
  if (params === '' || params === '0') return false;
  return params.split(';').some((raw) => {
    const n = Number.parseInt(raw, 10);
    if (!Number.isInteger(n)) return false;
    if (n >= 1 && n <= 9) return true; // common attributes
    if (n >= 11 && n <= 21) return true; // alternate fonts, Fraktur, double underline
    if (n === 26) return true; // proportional spacing
    if (n >= 30 && n <= 38) return true; // foreground, including extended color
    if (n >= 40 && n <= 48) return true; // background, including extended color
    if (n >= 51 && n <= 53) return true; // framed, encircled, overlined
    if (n === 58) return true; // underline color
    if (n >= 60 && n <= 64) return true; // ideogram decorations
    if (n >= 73 && n <= 74) return true; // superscript, subscript
    if (n >= 90 && n <= 97) return true; // bright foreground
    if (n >= 100 && n <= 107) return true; // bright background
    return false;
  });
}
