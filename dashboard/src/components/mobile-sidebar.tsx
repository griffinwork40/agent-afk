import { cn } from "@/lib/utils";

interface MobileSidebarProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

export function MobileSidebar({ open, onClose, children }: MobileSidebarProps) {
  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/50 transition-opacity duration-200 md:hidden",
          open ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        )}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* Drawer */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 w-64 bg-sidebar transition-transform duration-200 ease-in-out md:hidden",
          open ? "translate-x-0" : "-translate-x-full"
        )}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </>
  );
}

interface HamburgerButtonProps {
  onClick: () => void;
  className?: string;
}

export function HamburgerButton({ onClick, className }: HamburgerButtonProps) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "inline-flex items-center justify-center rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground md:hidden",
        className
      )}
      aria-label="Open sidebar"
    >
      <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
      </svg>
    </button>
  );
}
