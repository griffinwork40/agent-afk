/**
 * Signature — the page's visual law, rendered once as a slim hero band.
 *
 * Encodes "signal → depth → compression → rise → embodiment" left-to-right:
 *   signal      a small node (upper-left) with concentric ripples — a faint
 *               mark on the surface implying structure beneath it.
 *   depth       several braided traces fan down into the cool lower band —
 *               the real local complexity you descend into.
 *   compression those repeated passes converge toward one threshold and
 *               compress into a single confident route.
 *   rise        that earned route climbs to the upper-right.
 *   embodiment  it resolves into a warm node — the "ping", work made usable.
 * One crisp measuring rule crosses the whole field (organic depth + one
 * ruthless line of measurement).
 *
 * Pure SVG, no client JS, no dependencies. Decorative → aria-hidden. All
 * colour comes from --sig-* tokens (composes with the brand, never recolours
 * it); all motion lives in docs-theme.css under prefers-reduced-motion, so a
 * reduced-motion reader sees the fully-formed, static composition.
 *
 * Gradient ids are namespaced by `idPrefix` so multiple instances on one page
 * never collide (the same footgun documented on public/brand-mark.svg).
 */
export function Signature({ idPrefix = 'afkSig' }: { idPrefix?: string }) {
  const routeGrad = `${idPrefix}-route`;
  const ping = `${idPrefix}-ping`;

  return (
    <figure className="afk-signature not-prose" aria-hidden="true">
      <svg
        className="afk-sig"
        viewBox="0 0 1200 180"
        width="1200"
        height="180"
        role="presentation"
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          {/* The earned route: cold start → green route → warm use. */}
          <linearGradient id={routeGrad} x1="150" y1="120" x2="1058" y2="52" gradientUnits="userSpaceOnUse">
            <stop offset="0%" style={{ stopColor: 'rgb(var(--sig-route-cold))' }} />
            <stop offset="52%" style={{ stopColor: 'rgb(var(--sig-route-mid))' }} />
            <stop offset="100%" style={{ stopColor: 'rgb(var(--sig-route-warm))' }} />
          </linearGradient>
          {/* The ping — warm resolve at the route's end. */}
          <radialGradient id={ping} cx="50%" cy="50%" r="50%">
            <stop offset="0%" style={{ stopColor: 'rgb(var(--sig-route-warm))', stopOpacity: 0.9 }} />
            <stop offset="60%" style={{ stopColor: 'rgb(var(--sig-route-warm))', stopOpacity: 0.5 }} />
            <stop offset="100%" style={{ stopColor: 'rgb(var(--sig-route-warm))', stopOpacity: 0 }} />
          </radialGradient>
        </defs>

        {/* ── measure: one crisp rule crossing the organic field ───────────── */}
        <g className="afk-sig__measure">
          <line x1="80" y1="158" x2="1120" y2="158" />
          {/* interval ticks */}
          <line x1="150" y1="153" x2="150" y2="158" />
          <line x1="340" y1="153" x2="340" y2="158" />
          <line x1="530" y1="153" x2="530" y2="158" />
          <line x1="884" y1="153" x2="884" y2="158" />
          <line x1="1058" y1="153" x2="1058" y2="158" />
          {/* threshold marker at the compression point — a longer tick + a
              faint vertical guide where many passes resolve into one route. */}
          <line className="afk-sig__threshold" x1="706" y1="146" x2="706" y2="162" />
          <line className="afk-sig__axis" x1="706" y1="40" x2="706" y2="146" />
        </g>

        {/* ── depth: braided passes fanning through the cool lower band ─────── */}
        <g className="afk-sig__trace">
          <path d="M150 78 C 280 122, 470 140, 706 114" />
          <path d="M150 112 C 300 150, 480 156, 706 118" />
          <path d="M150 96 C 290 140, 470 150, 706 116" />
        </g>

        {/* ── compression → rise: the single earned route to the warm node ──── */}
        <path
          className="afk-sig__route"
          d="M150 96 C 300 140, 480 150, 706 115 C 852 92, 952 70, 1058 52"
          fill="none"
          stroke={`url(#${routeGrad})`}
        />

        {/* ── signal: a small mark, ripples implying hidden depth (upper-left) ─ */}
        <g className="afk-sig__signal">
          <circle className="afk-sig__ring" cx="132" cy="60" r="14" />
          <circle className="afk-sig__ring" cx="132" cy="60" r="26" />
          <circle className="afk-sig__ring" cx="132" cy="60" r="40" />
          <circle className="afk-sig__ripple" cx="132" cy="60" r="14" />
          <circle className="afk-sig__ripple afk-sig__ripple--2" cx="132" cy="60" r="14" />
          <circle className="afk-sig__node afk-sig__node--signal" cx="132" cy="60" r="3.5" />
        </g>

        {/* ── embodiment: the route lands as a warm ping (upper-right) ──────── */}
        <g className="afk-sig__embodiment">
          <circle className="afk-sig__glow" cx="1058" cy="52" r="17" fill={`url(#${ping})`} />
          <circle className="afk-sig__node afk-sig__node--warm" cx="1058" cy="52" r="4.5" />
          {/* a precise crosshair — measure meeting the resolved point */}
          <line className="afk-sig__crosshair" x1="1058" y1="38" x2="1058" y2="46" />
          <line className="afk-sig__crosshair" x1="1058" y1="58" x2="1058" y2="66" />
        </g>
      </svg>
    </figure>
  );
}
