/**
 * Markdown table renderer: horizontal scroll is the primary narrow-screen
 * behaviour, not row wrapping.
 *
 * Contract: on a 390 px phone a 5-column table used to wrap every cell, so a
 * row grew to ~150 px. Short cells now stay on one line (`whitespace-nowrap`),
 * long prose cells keep a readable minimum width and wrap, the font steps down
 * below `sm`, and an edge fade shows on whichever side still has content to
 * scroll to. The wrapper stays a focusable, labelled region (axe:
 * scrollable-region-focusable) so keyboard users can scroll it with arrows.
 */
import { Children, isValidElement, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Cells whose text is at most this long never wrap. */
export const SHORT_CELL_CHARS = 40;

/** Plain text of a React subtree (strings and numbers only). */
export function nodeText(node: ReactNode): string {
  let out = '';
  Children.forEach(node, (child) => {
    if (typeof child === 'string' || typeof child === 'number') out += String(child);
    else if (isValidElement<{ children?: ReactNode }>(child)) out += nodeText(child.props.children);
  });
  return out;
}

/** Class for a th/td: no-wrap for short content, readable min width for long. */
export function cellClass(children: ReactNode): string {
  return nodeText(children).trim().length <= SHORT_CELL_CHARS
    ? 'whitespace-nowrap'
    : 'min-w-[14rem] max-w-[28rem]';
}

export function ScrollTable({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);
  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [measure]);

  return (
    <div className="relative mb-2" data-table-scroll={edges.right || edges.left ? 'scrollable' : 'fits'}>
      <div
        ref={ref}
        onScroll={measure}
        className="overflow-x-auto rounded border border-border focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        tabIndex={0}
        aria-label="data table"
        role="region"
      >
        <table className="w-full text-xs sm:text-sm">{children}</table>
      </div>
      <div aria-hidden data-edge-fade="left"
        className={cn('pointer-events-none absolute inset-y-px left-px w-6 rounded-l bg-gradient-to-r from-background to-transparent transition-opacity', edges.left ? 'opacity-100' : 'opacity-0')} />
      <div aria-hidden data-edge-fade="right"
        className={cn('pointer-events-none absolute inset-y-px right-px w-8 rounded-r bg-gradient-to-l from-background to-transparent transition-opacity', edges.right ? 'opacity-100' : 'opacity-0')} />
    </div>
  );
}
