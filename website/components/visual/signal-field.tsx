/**
 * SignalField — the hero motif of the Agent AFK docs visual signature.
 *
 * Encodes, in one self-contained inline SVG, the full motion the signature is
 * built around:
 *
 *   signal -> depth -> compression -> rise -> embodiment
 *
 *   - SIGNAL: a small bright node (the brand "ping" orange) at the lower-left,
 *     the visible symptom on the surface.
 *   - DEPTH:  concentric rings + a layered contour basin spreading beneath and
 *     around the node — the submerged structure is far larger than the signal.
 *     The basin lines bleed past the frame, implying the system continues
 *     beyond what the page shows.
 *   - COMPRESSION: several faint "ghost" traces (prior passes) on the left that
 *     converge into ONE confident route — iteration worn into a single path.
 *   - RISE / EMBODIMENT: that route climbs from the deep lower-left toward the
 *     warm upper-right, resolving into a clear endpoint node near where the
 *     page's "Get started" call sits.
 *   - MEASURE: one crisp scope rule (axis tick + coordinate label) crosses the
 *     organic field — "living complexity crossed by clean judgment."
 *
 * It is purely decorative: aria-hidden, pointer-events:none, and it occupies a
 * zero-height anchor so it never displaces the hero copy. All motion lives in
 * signature.css and is disabled under prefers-reduced-motion (the composition
 * still reads when frozen). No client JS, no dependencies.
 *
 * Reusable: drop <SignalField /> at the top of any page's hero region. The
 * `seed` prop nudges the route/basin so sibling pages can share the hand
 * without repeating the identical graphic.
 */

export interface SignalFieldProps {
  /**
   * Small integer that perturbs the route + basin so different pages feel
   * related but not identical (repetition with variation). Default 0.
   */
  seed?: number;
  /** Optional extra className on the host wrapper. */
  className?: string;
}

export function SignalField({ seed = 0, className }: SignalFieldProps) {
  // Deterministic, tiny perturbations from the seed — keep the composition
  // recognisably the same while letting it vary per page.
  const jitter = ((seed % 5) - 2) * 4; // -8..8
  const routeMidY = 96 + jitter;

  // The earned route: faint ghost passes converge into one confident curve.
  // Coordinate system: 0..640 x, 0..360 y. The node sits low-left (~96,250),
  // the resolved endpoint rises high-right (~556,70).
  const mainRoute = `M 96 250
    C 150 232, 168 210, 214 ${routeMidY + 86}
    S 300 150, 360 ${routeMidY + 44}
    S 470 110, 556 70`;

  // Ghost passes: same destination, scattered approaches that compress in.
  const ghostRoutes = [
    `M 96 250 C 168 250, 196 200, 250 188 S 360 168, 430 120 S 506 96, 556 70`,
    `M 96 250 C 140 218, 200 224, 258 ${routeMidY + 70} S 348 132, 412 134 S 500 92, 556 70`,
    `M 96 250 C 176 246, 150 184, 236 176 S 372 196, 440 132 S 520 102, 556 70`,
  ];

  return (
    <div className={className ? `signal-field ${className}` : 'signal-field'} aria-hidden="true">
      <svg
        className="signal-field__svg"
        viewBox="0 0 640 360"
        fill="none"
        preserveAspectRatio="xMidYMax meet"
        role="presentation"
        focusable="false"
      >
        <defs>
          {/* Route gradient: cool/green (depth) -> warm orange (embodiment). */}
          <linearGradient id="sf-route-grad" x1="96" y1="250" x2="556" y2="70" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="var(--sig-cool)" />
            <stop offset="48%" stopColor="var(--sig-mid)" />
            <stop offset="100%" stopColor="var(--sig-warm)" />
          </linearGradient>

          {/* Node glow — the brand ping. */}
          <radialGradient id="sf-node-grad" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="var(--sig-warm-soft)" />
            <stop offset="55%" stopColor="var(--sig-warm)" />
            <stop offset="100%" stopColor="var(--sig-warm-deep)" />
          </radialGradient>

          {/* Basin contour stroke — cool, low opacity, the hidden structure. */}
          <linearGradient id="sf-contour-grad" x1="0" y1="360" x2="640" y2="0" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="var(--sig-mid)" stopOpacity="0.5" />
            <stop offset="60%" stopColor="var(--sig-cool)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--sig-warm)" stopOpacity="0.22" />
          </linearGradient>

          {/* Soft mask so the whole field fades into the page edges — nothing
              hard-clips, so it reads as "excavated", not pasted on. */}
          <radialGradient id="sf-fade" cx="22%" cy="72%" r="85%">
            <stop offset="0%" stopColor="#fff" stopOpacity="1" />
            <stop offset="70%" stopColor="#fff" stopOpacity="0.65" />
            <stop offset="100%" stopColor="#fff" stopOpacity="0" />
          </radialGradient>
          <mask id="sf-fade-mask">
            <rect x="-40" y="-40" width="720" height="440" fill="url(#sf-fade)" />
          </mask>
        </defs>

        <g mask="url(#sf-fade-mask)">
          {/* ---- DEPTH: layered contour basin around/under the node -------- */}
          {/* Concentric contour rings imply a pocket in the field; they drift
              slowly (breathing structure). Centred on the signal node. */}
          <g className="sf-drift" stroke="url(#sf-contour-grad)" fill="none">
            <ellipse cx="120" cy="250" rx="64" ry="30" strokeWidth="1" opacity="0.5" />
            <ellipse cx="120" cy="250" rx="118" ry="54" strokeWidth="1" opacity="0.36" />
            <ellipse cx="120" cy="250" rx="182" ry="82" strokeWidth="1" opacity="0.24" />
            <ellipse cx="120" cy="250" rx="252" ry="112" strokeWidth="1" opacity="0.15" />
            <ellipse cx="120" cy="250" rx="330" ry="146" strokeWidth="1" opacity="0.09" />
          </g>

          {/* A few open contour arcs sweeping across the whole field — the
              structure extends well beyond the local pocket. */}
          <g stroke="url(#sf-contour-grad)" fill="none" opacity="0.5">
            <path d="M -20 318 C 150 300, 300 312, 470 286 S 640 250, 700 268" strokeWidth="1" />
            <path d="M -20 350 C 180 338, 320 348, 500 320 S 660 296, 700 308" strokeWidth="1" />
          </g>

          {/* ---- EXPANDING RIPPLES: the signal propagating outward --------- */}
          <g stroke="var(--sig-warm)" fill="none">
            <circle className="sf-ripple" cx="120" cy="250" r="40" strokeWidth="1.2" />
            <circle className="sf-ripple sf-ripple--2" cx="120" cy="250" r="40" strokeWidth="1.2" />
            <circle className="sf-ripple sf-ripple--3" cx="120" cy="250" r="40" strokeWidth="1.2" />
          </g>

          {/* ---- COMPRESSION: ghost passes converging into the route ------- */}
          <g stroke="url(#sf-route-grad)" fill="none" strokeLinecap="round">
            {ghostRoutes.map((d, i) => (
              <path
                key={i}
                className="sf-route--ghost"
                d={d}
                strokeWidth="1"
                style={{ animationDelay: `${0.15 * i}s` }}
              />
            ))}
          </g>

          {/* ---- THE EARNED PATH: one confident route, rising -------------- */}
          <path
            className="sf-route"
            d={mainRoute}
            stroke="url(#sf-route-grad)"
            strokeWidth="2.25"
            strokeLinecap="round"
          />

          {/* ---- MEASURE: one ruthless scope rule across the field --------- */}
          {/* A crisp vertical axis tick with a coordinate label — clean
              judgment laid over the organic field. Placed at the compression
              midpoint where the route resolves. */}
          <g stroke="var(--color-fd-muted-foreground, #9b9bae)" opacity="0.5">
            <line x1="360" y1="40" x2="360" y2="300" strokeWidth="0.75" strokeDasharray="3 5" />
            <line x1="354" y1="40" x2="366" y2="40" strokeWidth="0.75" />
            <line x1="354" y1="300" x2="366" y2="300" strokeWidth="0.75" />
          </g>
          <text
            x="370"
            y="52"
            fill="var(--color-fd-muted-foreground, #9b9bae)"
            opacity="0.55"
            fontSize="10"
            fontFamily="var(--font-mono, ui-monospace, monospace)"
            letterSpacing="0.06em"
          >
            depth → signal
          </text>

          {/* ---- THE SIGNAL + THE ARRIVAL nodes ---------------------------- */}
          {/* Resolved endpoint (embodiment) — quiet, warm, up-right. */}
          <circle cx="556" cy="70" r="4.5" fill="url(#sf-node-grad)" opacity="0.92" />
          <circle cx="556" cy="70" r="9" fill="none" stroke="var(--sig-warm)" strokeWidth="0.75" opacity="0.4" />

          {/* The signal node — the bright origin, pulsing. */}
          <circle className="sf-node" cx="120" cy="250" r="6" fill="url(#sf-node-grad)" />
          <circle cx="120" cy="250" r="11" fill="none" stroke="var(--sig-warm)" strokeWidth="1" opacity="0.45" />
        </g>
      </svg>
    </div>
  );
}

export default SignalField;
