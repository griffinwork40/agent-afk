# Visual Signature — Agent AFK Docs

A subtle, reusable visual system layered onto the existing fumadocs docs site.
It encodes one worldview without ever stating it on the page:

> A small **signal** on the surface reveals hidden **depth** beneath it. You
> descend into local complexity, find the structure that survives contact with
> reality, **compress** repeated passes into an earned path, then **rise** into
> something usable enough to live, build on, and share — **embodiment**.
>
> **signal → depth → compression → rise → embodiment**

The signature is **additive and reusable**, not a teardown. It adapts to the
site's existing dark-terminal / brand-orange identity rather than overwriting
it. Every decorative layer sits *behind* content at low opacity, is
`pointer-events: none`, and fully degrades under `prefers-reduced-motion`.

---

## 1. What changed (concise)

| File | Change |
|---|---|
| `app/(docs)/signature.css` | **New.** The entire reusable visual system: tokens, the three motifs, card/code-block treatments, the motion gate, and responsive recomposition (~360 lines, no dependencies). |
| `app/(docs)/components/SignalField.tsx` | **New.** Hero motif: a small bright signal node over concentric topographic contours rising from a dense lower-left basin. Wraps the opening copy. |
| `app/(docs)/components/EarnedPathDivider.tsx` | **New.** Reusable section separator: faint repeated traces converging into one earned route, crossed by a scope rule with tick marks. Three `variant`s (`converge`, `channel`, `rise`) so it recurs with variation. |
| `app/(docs)/layout.tsx` | Imports `signature.css` after `docs-theme.css`. |
| `app/(docs)/[[...slug]]/page.tsx` | Registers `SignalField` + `EarnedPathDivider` in the MDX component map (alongside the existing `Card`/`Cards`). |
| `content/docs/index.mdx` | The intro page now expresses the full motion: hero wrapped in `<SignalField>`, the Get-started CTA in an `elevated-field`, generic `---` and section gaps replaced with `<EarnedPathDivider>` variants, and a warm `elevated-field` arrival CTA at the foot. **No copy, links, or headings were removed.** |

Nothing outside `website/` is touched. No new npm dependencies. No content,
navigation, search, dark-mode, or a11y behavior was removed or weakened.

---

## 2. The visual logic

The brief offers six laws and many motifs. Per its own decision rule, I chose
the **smallest coherent set — three recurring motifs** — repeated with
variation, rather than a collage of every effect. They map 1:1 onto the
worldview's five beats:

### Motif A — `signal-field` / `deep-field` → **signal + depth**
A small bright **signal node** (echoing the brand "ping" in the Handoff Arc
mark) sits at the **upper-right** over **concentric contour rings** emanating
from a dense **lower-left basin**. The visible symptom is a 10 px dot; the
implied structure beneath it is a field of eight nested basins fading into the
dark. A second, fainter offset basin hints that the submerged structure isn't
one tidy target.

- The hero (`<SignalField>`) is the clearest statement.
- A whisper-quiet version (`#nd-docs-layout::before`) washes the whole docs
  surface — a fixed cool basin at the lower-left, a faint warm rise at the
  upper-right — so the content scrolls *through* the field (subtle parallax)
  and every page feels like it sits on the same depth.

### Motif B — `earned-path` + `scope-rule` → **compression**
The recurring transformation device, and the literal section separator. Several
**faint traces** (repeated passes) **converge into one confident route**,
crossed by a single **crisp scope rule with tick marks**. This is the brief's
*"organic depth + one ruthless line of measurement."* The route **draws itself
once on mount** — many passes compressing into one earned path. It recurs with
variation via the `variant` prop so it reads as one hand, never a stamped
graphic:

- `converge` — traces fan in and resolve flat (after the hero, "you found the path").
- `channel` — near-parallel routed band (between the dense feature sections).
- `rise` — the route lifts toward the upper-right (just before the CTA).

### Motif C — `elevated-field` → **rise + embodiment**
The warm arrival zone. The primary CTAs (Get started, and the closing
Quickstart / How-It-Works pair) sit in an `elevated-field`: a warm rim-light,
the brand orange brought forward, the strongest sense of *arrival* and the
least visual friction. This is where the page has "risen" out of the depth and
become usable — embodiment happens outward and warm.

### Supporting treatments (same grammar, not new motifs)
- **Cards as extracted artifacts** — `#nd-page [data-card]` lift slightly on
  hover and reveal a hair-thin warm threshold along their left edge: a
  coordinate cue tying each card to the same vertical route. Cards read as
  *artifacts pulled from the field / stages along a route*, not floating stock
  rectangles.
- **Code blocks as instruments** — `#nd-page figure.shiki` get a sharp warm
  threshold edge on the left: snippets framed as *evidence extracted from the
  field*. One precise structural edge against the organic ground.

### Composition & emotional movement
The whole page follows the brief's default: **dense lower-left → compressed
center → resolved upper-right**, and **cold depth → earned route → warm use**.
Discovery zones (top, hero, features) read cooler/inward; the CTA reads
warmer/outward. The page rises because it first went deep enough.

---

## 3. Reusable tokens, components & utilities

### CSS custom properties (in `signature.css`)
All derive from the existing brand palette — no new hue is introduced. They
adapt for light theme via `html:not(.dark)`.

| Token | Role |
|---|---|
| `--sig-depth-0`, `--sig-depth-1` | Cool basin grounds (deepest → mid). |
| `--sig-contour`, `--sig-contour-2` | Faint topographic ring strokes. |
| `--sig-cool-glow` | Cool basin glow (discovery). |
| `--sig-signal`, `--sig-signal-soft` | The bright signal (= brand orange). |
| `--sig-warm-glow`, `--sig-warm-wash` | Warm rise / embodiment washes. |
| `--sig-path`, `--sig-path-faint` | The earned route + its pre-converged traces. |
| `--sig-rule`, `--sig-tick` | The ruthless measure line + ticks. |
| `--sig-drift`, `--sig-ripple` | Slow, geological motion timings. |

### Classes / hooks
| Selector | Purpose |
|---|---|
| `.signal-field` (+ `.contour-layer`, `.signal-node`) | Hero depth/signal field. |
| `.earned-path` (+ `.trace`, `.route`, `.rule`, `.tick`, `.scope-dot`) | Section separator grammar. |
| `.elevated-field` | Warm arrival/CTA wrapper (styles the `[data-card]` inside). |
| `#nd-page [data-card]` | Card-as-artifact treatment. |
| `#nd-page figure.shiki::before` | Code-block instrument edge. |
| `#nd-docs-layout::before` | Global submerged depth backdrop. |

### Components (registered in the MDX map; usable from any `.mdx` page)
- **`<SignalField>{children}</SignalField>`** — wrap any page's opening /
  problem-framing block to carry "signal over depth."
- **`<EarnedPathDivider variant="converge" | "channel" | "rise" />`** — a
  signature section break. Drop it anywhere `---` would go.

Both are pure markup (no client JS); all motion/colour lives in CSS.

---

## 4. How the page now expresses the five beats

| Beat | Where & how |
|---|---|
| **Signal** | The bright `signal-node` in the hero (upper-right) and the `scope-dot` riding the center of every divider — a small bright point the whole field/route resolves toward. |
| **Depth** | The hero's eight concentric contour basins rising from the lower-left, plus the fixed cool basin washing the whole docs surface. The visible signal is tiny; the implied structure is vast. |
| **Compression** | The `earned-path` dividers: many faint traces converge into one confident route that *draws itself* on mount — repeated passes compressed into a single earned line. The `channel` variant tightens this into a routed band between dense sections. |
| **Rise** | The `rise` divider lifts its route toward the upper-right just before the CTA; the global backdrop migrates from cool lower-left to warm upper-right; cards lift on hover. |
| **Embodiment** | The `elevated-field` CTAs — warmest light, brand orange forward, least friction, strongest arrival. "Get started" at the top of the descent and the Quickstart / How-It-Works pair at the foot are the most *present, usable* zones on the page. |

---

## 5. Accessibility, performance, responsiveness

- **Reduced motion** — `@media (prefers-reduced-motion: reduce)` strips every
  animation (contour drift, signal ripple, route draw) and shows the route
  fully drawn. The complete static composition still carries the signature;
  nothing essential depends on motion.
- **Contrast & semantics** — all decoration is `aria-hidden` /
  `role="presentation"`, `pointer-events: none`, and sits *behind* content
  (`z-index` below the article). Text contrast pairs are untouched. Headings,
  lists, links, code, search, and dark-mode toggling all behave exactly as
  before. The dividers replaced a decorative `---`; semantic section breaks
  still come from the MDX headings.
- **Performance** — no images, no blur filters in the always-on global
  backdrop, no JS libraries. The contours and routes are tiny inline SVG
  (a few `<ellipse>` / `<path>` each). Animations are GPU-friendly
  (`transform`/`opacity`/`stroke-dashoffset`) and run only in the hero +
  dividers.
- **Responsive recomposition** — at `≤640px` the hero field tightens, its
  basin origin pulls inboard (so it doesn't read as a lopsided corner glow on a
  narrow column), the signal node moves inboard so it never clips, and the
  dividers shorten. The system recomposes intentionally; it doesn't collapse
  into rubble.
- **Light + dark** — every token has a `html:not(.dark)` value; the depth
  channel lightens to a cool paper-grey and the warm channel/rule darken just
  enough to stay legible on the light ground.

---

## 6. Tradeoffs, omissions & future extensions

**Tradeoffs**
- I scoped the signature to the **docs intro page + the docs shell**, not every
  MDX page. The shell-level pieces (global backdrop, card/code treatments)
  apply site-wide automatically; the hero/divider components are opt-in per
  page. This keeps deep pages clean and fast while letting the homepage carry
  the clearest statement — repetition with variation, not a graphic stamped on
  every screen.
- The earned-path route draws on **mount**, not on scroll-into-view. A true
  scroll-reveal would need an `IntersectionObserver` (client JS); the mount
  animation is cheaper, dependency-free, and still reads as "the route forms."
- I used `color-mix()` and CSS `mask-image` (both widely supported in modern
  evergreen browsers, which this Next 15 site already targets). Each is used
  only for decoration with a sensible fallback (a plain border / no mask), so
  an older engine degrades gracefully rather than breaking.

**Deliberate omissions** (per the brief's "don't use every idea")
- No logo, mascot, or recurring illustration.
- No glassmorphism, particle fields, "AI glow," or random swooshes.
- No recolor of the brand; the cool depth channel is a desaturated tone already
  latent in the existing near-black backgrounds.

**Good future extensions**
- Add `<SignalField>` to the **How It Works** opener (its "session lifecycle"
  framing is a natural "signal over depth" moment) and a `channel` divider
  between its dense subsections.
- Promote the left-edge "route" cue on cards into a faint connecting spine that
  visually threads a vertical list of cards into one descending route.
- Optional scroll-linked variant of the global backdrop (cool→warm migration
  tied to scroll position) behind a `prefers-reduced-motion` guard, for the
  long pages.
- Extract the contour SVG into a parameterised generator (ring count / basin
  origin as props) so other pages can tune density without new markup.
