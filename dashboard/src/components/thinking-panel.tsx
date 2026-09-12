/** Collapsible thinking block — Brain icon, streaming state, truncation. */
import { useState } from "react";
import { Brain } from "lucide-react";

const TRUNCATE_AT = 200;

export function ThinkingPanel({
  text,
  isStreaming = false,
}: {
  text: string;
  isStreaming?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  const truncatable = text.length > TRUNCATE_AT;
  const displayText =
    truncatable && !expanded ? text.slice(0, TRUNCATE_AT) + "…" : text;

  return (
    <details className="group rounded-md border border-border/30 bg-muted/20">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-3 py-2 text-xs text-muted-foreground select-none hover:text-foreground">
        {/* Brain icon — pulses while still streaming */}
        <Brain
          className={[
            "h-3.5 w-3.5 shrink-0 text-brand/60",
            isStreaming ? "animate-pulse" : "",
          ]
            .filter(Boolean)
            .join(" ")}
        />

        <span className="font-medium">Thinking</span>

        {/* Character count badge */}
        {text.length > 0 && (
          <span className="text-[10px] text-muted-foreground/50 tabular-nums">
            {text.length.toLocaleString()} chars
          </span>
        )}

        {/* Three animated dots while streaming */}
        {isStreaming && (
          <span className="ml-0.5 flex items-center gap-px">
            {[0, 150, 300].map((delay) => (
              <span
                key={delay}
                className="inline-block h-1 w-1 rounded-full bg-muted-foreground/50 animate-shimmer-pulse"
                style={{ animationDelay: `${delay}ms` }}
              />
            ))}
          </span>
        )}
      </summary>

      {/* Content area */}
      <div className="border-t border-border/30 px-3 py-2">
        <p className="whitespace-pre-wrap break-words text-xs italic leading-relaxed text-muted-foreground/70">
          {displayText}
        </p>

        {/* Show more / Show less toggle */}
        {truncatable && (
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              setExpanded((v) => !v);
            }}
            className="mt-1.5 text-[10px] text-brand/60 hover:text-brand/80 transition-colors"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
    </details>
  );
}
