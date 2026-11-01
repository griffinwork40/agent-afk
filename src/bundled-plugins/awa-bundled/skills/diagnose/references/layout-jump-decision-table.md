# Layout Jump Decision Table

Consult this reference when a bug report mentions **jump**, **gap**, **shift**, **pop**, **reflow**, or **flicker** in a UI context (TUI, web, or desktop). These keywords warrant checking layout behavior; they do not establish a single root cause or remedy.

## Core invariant

First establish the intended layout contract and inspect the element's existing layout footprint:

- **Intended overlay** (e.g. a floating toast or modal): it should not displace siblings. Absolute/fixed positioning and layering can be appropriate; do not reserve in-flow space merely because the overlay appears dynamically.
- **Intentional expansion/collapse** (e.g. an accordion or expanding sidebar): sibling movement may be expected. Verify the intended transition rather than forcing a permanently reserved box.
- **Stable in-flow footprint** (e.g. a mascot bar or loading slot whose siblings should stay put): if insertion/removal or resizing changes that footprint, **reserve space before reveal, not after**. If the element already retains its in-flow footprint, investigate another cause (e.g. changing dimensions, margins, or ancestor layout) rather than adding a redundant placeholder.

The decision table below applies to unintended shifts where a stable in-flow footprint is required.

## Signal keywords

| Keyword | Example report phrasing |
|---------|------------------------|
| jump | "the input area jumps up" |
| gap | "there's a gap when X appears" |
| shift | "content shifts down when the banner loads" |
| pop | "the element pops in and pushes everything" |
| reflow | "reflow when toggling the sidebar" |
| flicker | "layout flickers on mount" |

## Decision table

| Symptom | Root cause | Fix strategy | Anti-pattern to avoid |
|---------|-----------|-------------|----------------------|
| Element appears and displaces siblings | Conditional render inserts new layout space | Reserve space with hidden/opacity-zero placeholder; toggle visibility, not existence | Using z-index/absolute positioning instead of preserving the required in-flow footprint (not an exclusion for intended overlays); animation-delay |
| Element disappears and siblings collapse | Conditional render removes layout space | Keep element in DOM with `visibility: hidden` or `opacity: 0`; preserve its layout box | Removing from DOM and re-inserting |
| Element animates in and causes reflow | Height/width transition from 0 triggers layout recalc | Reserve full space in a fixed-size wrapper; animate content within it using `transform: scale` or `opacity` | Animating `height`/`width`/`max-height` from 0 (all change the layout box) |
| Content shifts after async load | Placeholder absent during fetch; content insertion changes layout | Reserve exact or minimum dimensions before content arrives | Rendering nothing then inserting loaded content |
| Show/hide toggle causes jump per cycle | Each toggle adds/removes layout participation | Toggle `opacity` or `visibility`, not `display: none`/DOM presence | Conditional rendering (`if`/`v-if`/ternary) that adds/removes nodes |

## Verification

For the stable in-flow footprint remedy, a fix is valid when:

1. The target element can cycle through every show/hide state without unintended sibling movement
2. The reserved in-flow footprint remains stable during the visibility transition, even if content inside the wrapper mounts/unmounts
3. The fix survives fast repeated toggles (no transient jump on race conditions)

For intended overlays or intentional expansion/collapse, verify the declared layout contract instead: overlays do not displace siblings; expansion/collapse produces only the intended movement, including under fast repeated toggles.

## Falsifier

The reservation diagnosis is wrong for a stable in-flow case if the jump is fixed durably without stabilizing a changing footprint and does not recur under repeated show/hide cycles. Intended overlays, intentional expansion/collapse, and elements that already retain their in-flow footprint do not establish a need for additional space reservation.

## Provenance

Derived from pattern card `layout-jumps-caused-by-dynamic-element-insertion-a-2026-10-04t21-54-24-831` (session `1d6cf0de`, score 26/35, status: operational). Original fix: opacity-toggle reservation for mascot-bar vertical jump in Goblin Portal TUI.
