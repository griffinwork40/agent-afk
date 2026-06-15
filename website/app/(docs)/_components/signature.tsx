/* ==========================================================================
   Agent AFK Docs — Visual Signature components
   --------------------------------------------------------------------------
   Reusable React wrappers that mount the signature system into MDX content.
   They carry NO copy and NO interactivity — they are pure presentational
   shells around existing prose, so content, links, search and a11y are
   untouched. All visual weight lives in signature.css; these components only
   place the named layers (deep-field, contour-layer, signal-field, route,
   elevated-field, extract-field, threshold) around the right content.

   Because they render no semantic landmarks of their own, they are safe to
   drop into any docs page. The field layers are aria-hidden + pointer-events
   none, so screen readers and keyboard users never encounter them.
   ========================================================================== */
import type { ReactNode } from 'react';

/* Lightweight topographic contour as an inline SVG data URI. Concentric,
   slightly irregular rings imply terrain basins/pockets rather than a perfect
   bullseye — "topology, not decoration." Stroke colours are baked from the
   brand DNA (arc-green + structural grey) at low alpha so it reads as faint
   carved relief. Kept tiny (no runtime cost, no extra request).

   Invariant: this string is a valid, URL-encoded SVG — keep the encoding of
   '#', '<', '>' and quotes intact when editing or the background-image drops. */
const CONTOUR_SVG = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='600' height='600' viewBox='0 0 600 600'%3E%3Cg fill='none' stroke-width='1'%3E%3Cg stroke='%235cb87f' stroke-opacity='0.16'%3E%3Cpath d='M120 540 C 220 470, 250 360, 200 280 C 150 200, 60 190, 30 120'/%3E%3Cpath d='M170 560 C 290 480, 330 350, 280 250 C 235 160, 120 150, 90 70'/%3E%3Cpath d='M70 520 C 150 470, 175 380, 140 310 C 105 240, 30 235, 5 175'/%3E%3C/g%3E%3Cg stroke='%237c7c94' stroke-opacity='0.12'%3E%3Cpath d='M230 575 C 360 500, 415 360, 360 250 C 312 155, 180 150, 150 60'/%3E%3Cpath d='M300 585 C 440 510, 500 350, 445 235 C 398 135, 250 130, 225 40'/%3E%3C/g%3E%3Ccircle cx='150' cy='430' r='4' fill='%23f9854b' fill-opacity='0.30' stroke='none'/%3E%3C/g%3E%3C/svg%3E`;

/**
 * SignatureField — the page-wide ambient backdrop.
 * Mounts the deep-field (cool basin lower-left -> warm rise upper-right) and
 * the drifting contour-layer once per page, behind all content. Render it
 * once near the top of a docs page; everything else paints over it.
 */
export function SignatureField() {
  return (
    <>
      <div className="afk-deep-field" aria-hidden="true" />
      <div
        className="afk-contour-layer"
        aria-hidden="true"
        style={{ backgroundImage: `url("${CONTOUR_SVG}")` }}
      />
    </>
  );
}

/**
 * SignalField — the hero opening: a small bright signal over implied depth.
 * Wraps the intro block. Adds the ripple/node field (law #1) and the left-edge
 * earned-path + scope-rule (laws #3 + #5) behind the children. Children render
 * normally on top, so the hero copy and its CTA are unchanged.
 */
export function SignalField({ children }: { children: ReactNode }) {
  return (
    <div className="afk-signal-field">
      {/* the discovered route + its one ruthless measure, in the left gutter */}
      <div className="afk-route" aria-hidden="true">
        <div className="afk-scope-rule" />
      </div>
      {children}
    </div>
  );
}

/**
 * ExtractField — wraps a group of feature cards so each reads like an artifact
 * extracted from the same deeper system (carved recess + route edge on hover),
 * instead of a pile of disconnected boxes. Purely a styling scope.
 */
export function ExtractField({ children }: { children: ReactNode }) {
  return <div className="afk-extract-field">{children}</div>;
}

/**
 * ElevatedField — the warm arrival surface for the CTA / "Get started" zone.
 * The most embodied part of the page: warmer light + a lit threshold edge.
 */
export function ElevatedField({ children }: { children: ReactNode }) {
  return <div className="afk-elevated-field">{children}</div>;
}

/**
 * Threshold — a section transition that is a contour shift, not a generic rule.
 * Cool -> warm migration with a single measured tick at the crossing. Use in
 * place of an <hr> between major zones. Decorative, so aria-hidden.
 */
export function Threshold() {
  return <hr className="afk-threshold" aria-hidden="true" />;
}
