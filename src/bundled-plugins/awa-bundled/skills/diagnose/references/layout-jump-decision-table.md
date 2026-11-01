# Layout Jump Decision Table

Consult this reference when a bug report mentions **jump**, **gap**, **shift**, **pop**, **reflow**, or **flicker** in a UI context (TUI, web, or desktop). These keywords signal a layout-jump failure class with a known fix pattern.

## Core invariant

Layout jumps caused by dynamic element insertion are structurally identical regardless of the element type (mascot, toast, modal, sidebar, notification, skeleton loader). The fix class is always **reserve space before reveal, not after**.

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
| Element appears and displaces siblings | Conditional render inserts new layout space | Reserve space with hidden/opacity-zero placeholder; toggle visibility, not existence | z-index layering, absolute positioning, animation-delay |
| Element disappears and siblings collapse | Conditional render removes layout space | Keep element in DOM with `visibility: hidden` or `opacity: 0`; preserve its layout box | Removing from DOM and re-inserting |
| Element animates in and causes reflow | Height/width transition from 0 triggers layout recalc | Reserve full space in a fixed-size wrapper; animate content within it using `transform: scale` or `opacity` | Animating `height`/`width`/`max-height` from 0 (all change the layout box) |
| Content shifts after async load | Placeholder absent during fetch; content insertion changes layout | Reserve exact or minimum dimensions before content arrives | Rendering nothing then inserting loaded content |
| Show/hide toggle causes jump per cycle | Each toggle adds/removes layout participation | Toggle `opacity` or `visibility`, not `display: none`/DOM presence | Conditional rendering (`if`/`v-if`/ternary) that adds/removes nodes |

## Verification

A fix is valid when:

1. The target element can cycle through every show/hide state without any sibling element changing position
2. No new layout box is created or destroyed during the visibility transition
3. The fix survives fast repeated toggles (no transient jump on race conditions)

## Falsifier

This pattern is wrong if a layout-jump bug is fixed durably by removing the conditional render entirely (element always present with no space-reservation mechanism) and the jump does not recur under any show/hide cycle.

## Provenance

Derived from pattern card `layout-jumps-caused-by-dynamic-element-insertion-a-2026-10-04t21-54-24-831` (session `1d6cf0de`, score 26/35, status: operational). Original fix: opacity-toggle reservation for mascot-bar vertical jump in Goblin Portal TUI.
