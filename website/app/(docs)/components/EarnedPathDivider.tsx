/**
 * EarnedPathDivider — the reusable section separator of the visual signature.
 *
 * Replaces the flat MDX "---" rule. Several faint TRACES (repeated passes)
 * converge into one confident ROUTE, crossed by a single crisp SCOPE RULE with
 * tick marks — "organic depth + one ruthless line of measurement." The route
 * draws itself once on mount (compression of many passes into one earned
 * path); motion is gated by prefers-reduced-motion in signature.css.
 *
 * The `variant` prop lets the same motif recur with variation down the page so
 * it reads as one hand, not a stamped graphic. All variants share the trace →
 * route → measure grammar; only the curve and the rule's emphasis shift.
 *
 *   "converge"  (default) — traces fan in from the left and resolve to a flat
 *                           confident line on the right. Rule spans full width.
 *                           Use between discovery sections.
 *   "rise"               — the route lifts toward the upper-right (embodiment).
 *                           Use just before the warm CTA zone.
 *   "channel"            — tighter, near-parallel traces (a routed channel).
 *                           Use between dense feature sections.
 *
 * Pure markup, no client JS. aria-hidden — it is decorative; semantic section
 * breaks come from the MDX headings around it.
 */
type Variant = 'converge' | 'rise' | 'channel';

interface Props {
  variant?: Variant;
}

// viewBox is 400×40; paths are authored in that space and stretch responsively
// (preserveAspectRatio none) so the route always spans the column width.
const ROUTES: Record<Variant, { traces: string[]; route: string; ruleY: number }> = {
  converge: {
    // Faint passes entering at varied heights, all converging to y≈20 by x≈230.
    traces: [
      'M0,8   C90,8   150,20  230,20 S360,20 400,20',
      'M0,32  C90,32  150,20  230,20 S360,20 400,20',
      'M0,15  C100,15 160,21  230,20 S360,20 400,20',
      'M0,26  C100,26 160,19  230,20 S360,20 400,20',
    ],
    route: 'M0,20 C90,20 150,20 230,20 S360,20 400,20',
    ruleY: 20,
  },
  rise: {
    // Passes that lift toward the upper-right — the rise into embodiment.
    traces: [
      'M0,30  C120,30 220,18 400,8',
      'M0,34  C120,34 220,22 400,12',
      'M0,26  C120,26 220,15 400,6',
    ],
    route: 'M0,32 C130,32 230,16 400,8',
    ruleY: 32,
  },
  channel: {
    // Near-parallel routed band — a compressed channel worn into the field.
    traces: [
      'M0,14 C140,14 260,14 400,14',
      'M0,26 C140,26 260,26 400,26',
      'M0,17 C140,19 260,17 400,18',
      'M0,23 C140,21 260,23 400,22',
    ],
    route: 'M0,20 C140,20 260,20 400,20',
    ruleY: 20,
  },
};

export function EarnedPathDivider({ variant = 'converge' }: Props) {
  const spec = ROUTES[variant];
  // Tick marks along the scope rule — evenly spaced measure cues. The center
  // tick is taller (a threshold marker) and carries the signal dot.
  const ticks = [40, 120, 200, 280, 360];

  return (
    <div className="earned-path" data-signature="earned-path" data-variant={variant} role="presentation">
      <svg viewBox="0 0 400 40" preserveAspectRatio="none" aria-hidden="true">
        {/* Repeated pre-converged passes. */}
        {spec.traces.map((d, i) => (
          <path key={`t${i}`} className="trace" d={d} />
        ))}

        {/* The scope rule (the ruthless measure) + ticks. Authored AFTER the
            traces so the measure crosses cleanly over the organic field. */}
        <line className="rule" x1="0" y1={spec.ruleY} x2="400" y2={spec.ruleY} />
        {ticks.map((x, i) => {
          const isCenter = i === Math.floor(ticks.length / 2);
          const h = isCenter ? 7 : 3.5;
          return (
            <line
              key={`k${i}`}
              className="tick"
              x1={x}
              y1={spec.ruleY - h}
              x2={x}
              y2={spec.ruleY + h}
            />
          );
        })}

        {/* The one earned route — drawn last so it reads on top, and animated
            to draw itself once on mount. pathLength normalizes the dash math
            across the three different curves. */}
        <path className="route" d={spec.route} pathLength={1} />

        {/* The signal dot rides the threshold marker at center — the small
            bright point the whole route resolves toward. */}
        <circle className="scope-dot" cx="200" cy={spec.ruleY} r="2.4" />
      </svg>
    </div>
  );
}

export default EarnedPathDivider;
