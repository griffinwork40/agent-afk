/** Collapsible thinking block — dimmed italic text, no markdown. */
export function ThinkingPanel({ text }: { text: string }) {
  return (
    <details className="group rounded-md border border-border/50 bg-muted/30">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-muted-foreground select-none hover:text-foreground">
        {/* Chevron via CSS rotation */}
        <span className="inline-block transition-transform group-open:rotate-90">
          ▶
        </span>
        Thinking…
      </summary>
      <div className="border-t border-border/50 px-3 py-2">
        <p className="whitespace-pre-wrap font-serif text-xs italic text-muted-foreground">
          {text}
        </p>
      </div>
    </details>
  );
}
