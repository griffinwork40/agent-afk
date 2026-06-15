# Agent AFK Docs — Visual Signature

A subtle, **reusable** visual system layered onto the existing fumadocs docs
site (docs.agentafk.com). It is **additive**: nothing about the brand palette,
the "Handoff Arc" mark, the dark terminal aesthetic, the sidebar/TOC/search,
the content, or the responsive/light-mode behavior was replaced. The signature
is grown out of the identity that was already there.

The page now quietly embodies one worldview, without ever stating it literally:

> A small **signal** on the surface reveals hidden **depth** beneath it. You
> descend into the real local complexity, find the structure that survives
> contact with reality, **compress** repeated passes into an earned path, then
> **rise** into something usable enough to live, build on, and share
> (**embodiment**).

Motion: **signal → depth → compression → rise → embodiment.**

---

## 1. What changed (concise)

| File | Change |
|------|--------|
| `app/(docs)/signature.css` *(new)* | The whole reusable system: signature tokens + the three motifs as scoped CSS (field migration, contour dividers, artifact cards, elevated/deep field, signal-field motion + responsive + reduced-motion contracts). |
| `components/visual/signal-field.tsx` *(new)* | `<SignalField>` — the hero motif. One self-contained inline SVG that renders the full motion (signal node → contour basin → converging ghost passes → one earned route rising to a warm arrival node), crossed by one crisp scope rule. No deps, no client JS. |
| `components/visual/contour-divider.tsx` *(new)* | `<ContourDivider>` — a semantic `<hr>` rendered as a routed topographic transition instead of a flat rule. |
| `app/(docs)/layout.tsx` | Imports `signature.css` after `docs-theme.css` (one line). |
| `app/(docs)/[[...slug]]/page.tsx` | Registers `SignalField` + `ContourDivider` for MDX, and maps **all** `---` thematic breaks site-wide to `ContourDivider` (the `hr` component) so every page inherits the same hand. |
| `content/docs/index.mdx` | Adds `<SignalField />` to the hero; wraps the primary "Get started" Cards in `.sig-cta` (warmest arrival card) and the closing CTA in `.elevated-field` (the most embodied zone). Content/links unchanged. |

No new dependencies. Production build is green: all 28 pages prerender
statically; `tsc --noEmit` passes; the only console errors at runtime are the
pre-existing `@vercel/analytics` 404 in a keyless local server (unrelated).

---

## 2. The visual logic

The brand already contained the seed of the whole idea. The **Handoff Arc**
mark is a small orange "ping" sitting in the gap of a larger grey→green arc —
i.e. *a small bright signal implying a larger structure handed off*. The
signature simply takes that one glyph's logic and lets it govern the page:

- The **ping orange** (`#f97316`/`#ffc2a1`/`#d65a0e`) becomes the *signal* and
  the *warm embodiment* register.
- The arc's **grey→green** (`#6f6f86`→`#5cb87f`) becomes the *cool descent →
  structure-found* register.
- The deep `#07070b` background is the *depth* everything sits over.

Nothing is recolored. The motifs reuse those exact values as CSS variables
(`--sig-warm`, `--sig-cool`, `--sig-mid`, …), so the new shapes read as the same
hand as the mark.

The composition follows the brief's default movement —
**dense lower-left → compressed center → resolved upper-right** — and the
emotional movement **cold depth → earned route → warm use**: discovery happens
inward/cool/low-left; embodiment happens outward/warm/up-right.

### Restraint

Per the decision rule, only **three** recurring motifs are used (repetition
with variation, not a collage of every available effect), and every one is
tied back to the same law:

1. **Signal field** — signal over depth (hero).
2. **Earned path + scope rule** — compression into one route, crossed by one
   ruthless line of measurement (hero, and the measure echoes at card scale).
3. **Field migration** — cool/dense lower-left warming to upper-right, applied
   to the whole shell, to section transitions, and to cards-as-artifacts.

---

## 3. Reusable tokens / components / utilities added

### Components (`components/visual/`)
- **`<SignalField seed?={n} />`** — the hero motif. Drop it at the top of any
  page's hero region. `seed` deterministically perturbs the route + basin so
  sibling pages feel related but not identical. Decorative: `aria-hidden`,
  `pointer-events:none`, zero-height anchor (never displaces copy).
- **`<ContourDivider />`** — an explicit routed-contour section break. Also wired
  globally so plain MDX `---` becomes one automatically.

### CSS custom properties (signature tokens, in `:root`)
```
--sig-warm / --sig-warm-soft / --sig-warm-deep   the signal / embodiment orange
--sig-cool / --sig-mid                           the descent grey → structure green
--sig-contour-op / --sig-field-op                low field opacities (never fights copy)
--sig-ripple-dur / --sig-drift-dur               motion timing
```

### Utility classes (all scoped to `#nd-docs-layout` or opt-in)
- **`.signal-field` / `.signal-field__svg`** — host + bleed geometry for the
  hero SVG (incl. mobile recomposition + reduced-motion handling).
- **`.contour-divider`** — section transition as a topographic crossing.
- **`.deep-field`** — a reusable cool/dense "discovery" callout wrapper.
- **`.elevated-field`** — a reusable warm/clear "embodiment" wrapper (CTA/arrival).
- **`.sig-cta`** — marks the primary call's card(s) as the warmest arrival.
- **Artifact cards** — fumadocs `[data-card]`s gain a cool threshold top-edge, a
  carved lower-left contour recess, and a warm rise on hover/focus. Applied
  automatically to every docs card; no per-card markup.

These are intentionally generic so future pages can reach for `deep-field` /
`elevated-field` / `<SignalField seed=…/>` and stay on-system.

---

## 4. How the page expresses the five beats

- **Signal** — the small bright orange node at the hero's lower-left (the brand
  ping), pulsing slowly. The visible symptom.
- **Depth** — concentric contour rings + open basin arcs spread beneath and
  *past the frame edges* around that node: the submerged system is far larger
  than the signal. The whole docs shell also carries a cool, denser tint in its
  lower-left corner.
- **Compression** — several faint "ghost" traces (prior passes) converge into
  **one** confident route. Iteration worn into a single path, not a drawn
  swoosh.
- **Rise** — that route climbs from the cool low-left, through the green
  "structure-found" midtone, up toward the warm upper-right. Section dividers
  and card thresholds carry the same cool→warm gradient at smaller scale.
- **Embodiment** — the route resolves into a warm arrival node next to the
  **"Get started"** card (`.sig-cta`, warm border + lit threshold), and the page
  closes in an **`.elevated-field`** — the clearest, warmest, lowest-friction
  zone, the strongest sense of arrival.

The **one ruthless measure**: a crisp dashed scope-rule with a monospace
`depth → signal` coordinate label crosses the organic hero field — living
complexity crossed by clean judgment. The same "one precise edge" idea repeats
as the cards' threshold top-line.

---

## 5. Accessibility, performance, responsiveness

- **Reduced motion** — under `prefers-reduced-motion: reduce`, every animation
  is disabled and frozen in a *resolved* end state (route fully drawn, node
  steady). The composition is structural, so it still reads when static.
  *(Verified: route `animation-name: none`, `stroke-dashoffset: 0`.)*
- **Contrast** — all field art is low-opacity and sits **behind** content; the
  AA text contrast already met by `docs-theme.css` is preserved in both themes.
  *(Verified: hero body text ≈ `#e9e9f0` on dark, ≈ `#111118` on light.)*
- **Mobile** — the signal field recomposes intentionally (shorter, narrower
  bleed) rather than collapsing; **no horizontal overflow** at 375–390px.
  *(Verified: `scrollWidth === clientWidth`.)*
- **Semantics / a11y** — decorative SVG is `aria-hidden` + non-interactive;
  dividers remain real `<hr>` thematic breaks; no DOM/landmark changes; search,
  nav, TOC, and the brand mark are untouched.
- **Performance** — pure CSS + inline SVG, no JS on the client for the motifs,
  no new dependencies, no extra network requests. The field-migration backdrop
  is a single `position: fixed` pseudo-element.

---

## 6. Tradeoffs, omissions, future extensions

- **Only the hero carries the full motif.** By design (restraint / "not the
  signature graphic again"). Inner pages inherit the *quiet* signals — the
  field-migration backdrop, contour dividers, artifact cards — so they feel
  governed by the same law without repeating the hero graphic. `<SignalField>`
  is ready to drop into another page's hero (e.g. How It Works) with a different
  `seed` if a second focal point is ever wanted.
- **`hr` is globally remapped to `ContourDivider`.** High leverage (every `---`
  on every page becomes on-system with zero per-file edits) and reversible (one
  line in `page.tsx`). The element stays a semantic `<hr>`.
- **Motifs deliberately *not* used:** glassmorphism, particle fields, generic
  "AI glow", literal landscape art, and a recurring illustration/mascot — all on
  the brief's avoid list. The scope rule is the single "crisp measure"; adding
  more axes/scales risked tipping into poster territory.
- **Future extensions:** (a) a `<ScopeRule>` component if pages want the measure
  device standalone; (b) `seed`-varied `<SignalField>` on section landing pages;
  (c) a `data-sig-register="deep|warm"` attribute on `<section>`s to let long
  pages migrate cool→warm down the scroll; (d) an optional faint route in the
  sidebar rail. None are needed for the system to read today.
