import type { ReactNode } from 'react';

/**
 * SignalField — the hero motif of the Agent AFK visual signature.
 *
 * A small bright SIGNAL node sits at the upper-right over concentric
 * topographic CONTOURS emanating from a dense lower-left basin. The visible
 * symptom is tiny; the implied structure beneath it is vast. Children (the
 * opening copy + install line + CTA) stack above the field.
 *
 * Pure markup — no client JS. All motion/colour lives in signature.css and is
 * gated by prefers-reduced-motion. The SVG layers are decorative
 * (aria-hidden, pointer-events:none via CSS) so they never touch a11y or
 * content order.
 *
 * Reuse: drop <SignalField> around any page's opening / problem-framing block
 * to carry the same "signal over depth" feeling with no extra wiring.
 */
export function SignalField({ children }: { children: ReactNode }) {
  return (
    <div className="signal-field" data-signature="signal-field">
      {/* Concentric contour rings — the submerged topography. currentColor is
          set to --sig-contour by the CSS; outer rings fade via opacity. The
          rings are offset toward the lower-left (18%,100%) so the field reads
          as basins opening up-and-right (the compositional default). */}
      <div className="contour-layer" aria-hidden="true">
        <svg
          viewBox="0 0 400 240"
          preserveAspectRatio="xMidYMid slice"
          fill="none"
          stroke="currentColor"
        >
          {/* Eight concentric, slightly-irregular rings (basins) centred near
              the lower-left. Each is a closed cardinal-ish loop; the slight
              per-ring jitter keeps them organic, not mechanical. Outer rings
              carry less opacity to imply depth falloff. */}
          <g>
            <ellipse cx="60" cy="232" rx="40"  ry="30"  opacity="0.9" />
            <ellipse cx="58" cy="232" rx="78"  ry="58"  opacity="0.8" />
            <ellipse cx="62" cy="230" rx="118" ry="86"  opacity="0.68" />
            <ellipse cx="56" cy="232" rx="160" ry="118" opacity="0.55" />
            <ellipse cx="64" cy="228" rx="208" ry="152" opacity="0.42" />
            <ellipse cx="58" cy="232" rx="260" ry="190" opacity="0.30" />
            <ellipse cx="66" cy="226" rx="316" ry="232" opacity="0.20" />
            <ellipse cx="60" cy="230" rx="376" ry="278" opacity="0.12" />
          </g>
          {/* A second faint basin offset to the right — a hint of a separate
              submerged structure, so the field doesn't read as one tidy
              target. */}
          <g opacity="0.5">
            <ellipse cx="330" cy="150" rx="34" ry="26" opacity="0.5" />
            <ellipse cx="332" cy="148" rx="66" ry="50" opacity="0.32" />
            <ellipse cx="328" cy="152" rx="104" ry="80" opacity="0.18" />
          </g>
        </svg>
      </div>

      {/* The signal node — small, bright, upper-right; ripples slowly. The
          ripple rings are drawn by ::before/::after in CSS. */}
      <span className="signal-node" aria-hidden="true" />

      {children}
    </div>
  );
}

export default SignalField;
