import { cn } from '@/lib/utils';

// ── Animated collapse via CSS grid trick ──────────────────────────────────────

// Invariant: outer div uses `grid` with `grid-template-rows`; inner div uses
// `min-h-0` so the overflow is contained. Transition is on `grid-template-rows`
// which browsers can animate without triggering a layout recalc each frame.

export interface CollapseProps {
  open: boolean;
  children: React.ReactNode;
}

export function Collapse({ open, children }: CollapseProps) {
  return (
    <div
      className={cn(
        'grid transition-[grid-template-rows] duration-200 ease-out',
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]',
      )}
    >
      <div className="min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}
