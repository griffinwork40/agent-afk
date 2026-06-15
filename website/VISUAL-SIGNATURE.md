# Visual Signature — Agent AFK docs

A small, reusable visual layer added to the docs site (Next.js 15 + fumadocs)
that encodes one worldview into the page without changing a single word of copy,
a single link, or the existing brand identity:

> **A small signal on the surface reveals hidden depth beneath it. You descend
> into the real local complexity, find the structure that survives contact with
> reality, compress repeated passes into an earned path, then rise into something
> usable enough to live, build on, and share.**
>
> signal → depth → compression → rise → embodiment

It is **additive and discovered, not decorative**. Nothing was recoloured,
restructured, or removed; the signature is layered behind and around the
existing fumadocs prose, nav, search, TOC, and the "Handoff Arc" brand mark.

---

## 1. What changed (files)

| File | Change |
|------|--------|
| `app/(docs)/signature.css` | **New.** The whole visual system: tokens, named utility classes, keyframes, reduced-motion + responsive recomposition. ~490 lines, fully commented. |
| `app/(docs)/_components/signature.tsx` | **New.** Five tiny presentational React wrappers + one inline topographic SVG (data-URI). No copy, no interactivity, no hooks. The `_` prefix makes it a Next.js private folder (never routed). |
| `app/(docs)/layout.tsx` | +1 import (`./signature.css`) so the layer loads after the brand theme. |
| `app/(docs)/[[...slug]]/page.tsx` | Mounts `<SignatureField />` (ambient backdrop) once per page; registers the five wrappers in the MDX component map so any `.mdx` page can use them. |
| `content/docs/index.mdx` | The intro/hero wrapped in the signature wrappers. **All text and links unchanged**; two `---`/separators upgraded to `<Threshold />`. |

No new dependencies. No build-system changes. No content edits.

---

## 2. The visual logic

### The brand mark was already the Rosetta Stone

The existing "Handoff Arc" glyph (`public/brand-mark.svg`) **already travels the
whole arc**: a cool **grey endpoint node** → a routed **green arc** → a warm
**orange "ping"** breaking through the gap. That is *signal → route →
embodiment* compressed into one logo. The signature does not invent a new
language; it **expands that single glyph's DNA** into the page's composition,
backgrounds, section flow, and motion. Different pages feel like they came from
the same hand because they inherit the same node→route→ping logic the logo
already carries.

The brand palette is reused verbatim — brand orange `#f9854b`, arc-green
`#5cb87f`, structural grey — only *repositioned* along the depth→rise axis. The
deep, cool basins are derived from the existing `--color-bg` family; the warm
arrival light from `--color-accent`. Nothing is recoloured.

### The compositional law: dense lower-left → resolved upper-right

The brief's "dense lower-left → resolved upper-right" is expressed as **light,
not layout** (so it never fights fumadocs' grid or mobile reflow). The ambient
`deep-field` gathers a cool basin in the lower-left (where descent begins) and
lets a faint warm wash rise toward the upper-right (where embodiment lives).
The reader's eye starts deep and is drawn up-and-right along the route toward
the CTA.

### Three motifs, repeated with variation — not a collage

Per the decision rule, only the **smallest coherent set** of motifs is used:

1. **Signal over depth** — a small bright node with expanding concentric ripples,
   sitting above a vast, faintly-contoured submerged field. The signal is small;
   the implied system is enormous.
2. **The earned path + one ruthless measure** — a thin left-gutter device that
   pairs an organic *route* (cool→green→warm, the discovered path) with a crisp
   *scope-rule* (a measured axis, ticks, and a single warm threshold marker).
   "Organic depth + one ruthless line of measurement."
3. **Rise into embodiment** — a warmer, lighter, more open *elevated-field* for
   the CTA and the page's arrival zone, with a lit threshold edge brightening
   outward (toward action).

These three recur — in the hero, between sections (the `Threshold`), and inside
feature cards (the `extract-field` route-edge) — so the whole page feels
*governed by the same law* rather than sprinkled with effects.

---

## 3. Reusable tokens / components / utilities

### CSS custom properties (in `signature.css`)
Named after the motion so the system reads as its own worldview. All derived
from existing brand tokens; light-theme overrides included.

| Group | Tokens |
|-------|--------|
| Depth (cool, submerged) | `--afk-depth-1`, `--afk-depth-2`, `--afk-depth-line`, `--afk-depth-line-2` |
| Signal (the bright node + ripple) | `--afk-signal`, `--afk-signal-ring`, `--afk-signal-glow` |
| Route (the arc gradient) | `--afk-route-cool`, `--afk-route-mid`, `--afk-route-warm` |
| Measure (the ruthless line) | `--afk-rule`, `--afk-rule-tick`, `--afk-rule-mark` |
| Embodiment (warm arrival) | `--afk-warm-wash`, `--afk-warm-edge` |
| Motion timing | `--afk-rise`, `--afk-t-ripple`, `--afk-t-drift` |

### Utility classes
| Class | Role |
|-------|------|
| `.afk-deep-field` | Page-wide ambient basin (cool lower-left → warm upper-right). |
| `.afk-contour-layer` | Faint drifting topographic contours (inline SVG). |
| `.afk-signal-field` | Hero wrapper: ripple + node behind content. |
| `.afk-route` / `.afk-scope-rule` | Left-gutter earned-path + measured axis with marker. |
| `.afk-scope-rule--inline` | Standalone measure you can attach to any heading/block. |
| `.afk-elevated-field` | Warm arrival surface (CTA), lit threshold edge. |
| `.afk-extract-field` | Wraps card grids; gives each card a carved recess + route-edge. |
| `.afk-threshold` | A section transition that is a contour shift, not a generic `<hr>`. |

### React components (in `_components/signature.tsx`)
`<SignatureField />`, `<SignalField>`, `<ExtractField>`, `<ElevatedField>`,
`<Threshold />`. All are pure presentational shells (server components, no
hooks, `aria-hidden` decorative layers). Registered in the MDX map, so **any**
docs page can adopt the system, not just the homepage.

---

## 4. How the page expresses each stage

- **Signal** — the hero's small pulsing node + concentric ripples; the warm tick
  on the scope-rule marking where the route first breaks the surface. A visible
  symptom above a much larger hidden system.
- **Depth** — the cool `deep-field` basin and faint topographic `contour-layer`
  beneath everything; cards carry a cool recess pooling in their lower-left —
  each artifact still remembers the depth it came from. Depth is honoured as
  beautiful structure, not an ugly "before" state.
- **Compression** — the `earned-path`: repeated cool→green lines converging into
  one confident warm route, crossed by the ruthless `scope-rule`. Iteration
  becoming a single leveraged path.
- **Rise** — the warm/cool migration: cool discovery lower-left resolving to warm
  use upper-right; the `Threshold` separators migrate cool→warm left-to-right;
  card route-edges light from cool to warm on hover (the signal travelling).
- **Embodiment** — the `elevated-field` CTA: the warmest, most open, lowest-
  friction zone, with a lit threshold edge — cold depth fully risen into warm,
  usable action.

The emotional movement is **cold depth → earned route → warm use**, exactly as
the brief asks — discovery inward, embodiment outward.

---

## 5. Accessibility, performance, responsiveness

- **A11y** — every signature layer is `aria-hidden="true"` and
  `pointer-events: none`; no new landmarks, no focus traps, no tab stops. Copy
  contrast is untouched (fields sit behind content at low opacity). Verified in
  both dark and light themes (near-black text on light bg stays well above AA).
- **Reduced motion** — `@media (prefers-reduced-motion: reduce)` freezes *all*
  animation while keeping the full composition intact (the node, rings, route,
  and warm rise are meaningful at rest — they settle to a calm mid-state, no
  layout shift, nothing disappears).
- **Performance** — pure CSS gradients/masks + one ~670-byte inline SVG data-URI.
  No images, no extra requests, no JS, no libraries. `will-change` only on the
  single drifting layer.
- **Responsive recomposition** — at ≤768px the left-gutter route shrinks and the
  signal field tucks behind the heading; at ≤480px the absolute route is dropped
  entirely (no gutter) and the signal-field + inline measure carry the identity.
  Cards stack to one column. It **recomposes intentionally, never collapses into
  rubble** (verified at 420px).

All states above were rendered and visually verified (dark, light, hover, mobile).

---

## 6. Tradeoffs, omissions, future extensions

**Tradeoffs**
- The signature is intentionally *quiet*. It rewards a second look rather than
  shouting — chosen deliberately over a louder hero, because this is a docs site
  with an existing strong identity, and the brief says adapt, don't overwrite.
- The motifs lean on fumadocs' `[data-card]` and `#nd-docs-layout` hooks. These
  are the **versioned, officially-supported** selectors (per fumadocs'
  customize-ui guide); we deliberately avoid structural selectors (`> div`) that
  could break on upgrade. If fumadocs ever renames `[data-card]`, the
  `extract-field`/`elevated-field` card treatments degrade gracefully to plain
  cards (the wrappers still render; only the card-specific polish drops).

**Omissions (by the decision rule — not every idea was used)**
- No field-distortion / parallax-on-scroll. Scroll-linked motion would need JS
  and risks competing with copy; the static composition already reads.
- The signature is applied fully to the homepage hero; other pages currently get
  only the ambient `deep-field` + `contour-layer`. This is intentional restraint
  — the wrappers are wired into the MDX map so any page *can* opt in.

**Future extensions**
- Add `<SignalField>` to other high-intent pages (Quickstart hero, How-It-Works
  opening) for a stronger cross-page through-line.
- A `<ScopeRule>` MDX component using `.afk-scope-rule--inline` to annotate key
  headings as measured thresholds.
- A faint scroll-progress reveal on the `earned-path` (gated behind
  `prefers-reduced-motion`) so the route "draws in" as the reader descends.
- Promote the tokens into `globals.css` if the standalone marketing site
  (agentafk.com, separate repo) wants to share the same signal→rise language.
