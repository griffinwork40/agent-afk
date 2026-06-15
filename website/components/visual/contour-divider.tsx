/**
 * ContourDivider — a section transition rendered as a routed contour line
 * instead of a flat rule. Part of the Agent AFK docs visual signature: a
 * threshold crossing in the field (a faint cool->warm trace with a single
 * channel dipping through it and a node marking the crossing).
 *
 * It is a semantic <hr> (preserves the document outline / a11y meaning of a
 * thematic break) carrying the `.contour-divider` class whose visuals live in
 * signature.css. Drop <ContourDivider /> in MDX, or write a plain `---` rule
 * and let the page opt in — this component is the explicit form.
 *
 * Purely decorative styling; the <hr> itself remains a real separator.
 */
export function ContourDivider({ className }: { className?: string }) {
  return (
    <hr className={className ? `contour-divider ${className}` : 'contour-divider'} aria-hidden="false" />
  );
}

export default ContourDivider;
