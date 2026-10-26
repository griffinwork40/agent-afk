import { memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import type { Components } from 'react-markdown';
import { CodeBlock } from './code-block';
import { ScrollTable, cellClass } from './scroll-table';

// Contract: ul/ol use `pl-6 list-outside` (padding, not margin) so that
// markers (bullets and numbers) paint inside the scrollable content box. The
// old `ml-4` + default `list-inside` placed markers outside, causing two-digit
// numbers ("10.", "100.") to be clipped by content-visibility:auto containers.
const components: Components = {
  h1: ({ children }) => <h1 className="mb-3 text-xl font-bold">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 text-lg font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1.5 text-base font-semibold">{children}</h3>,
  // P1-8: 15px body (text-[15px]) for reading comfort. max-w-[70ch] keeps
  // line length ≤ 70 chars for prose; code/table siblings may exceed this.
  p: ({ children }) => (
    <p className="mb-2 last:mb-0 leading-relaxed text-[15px]">{children}</p>
  ),
  // P0-3: pl-6 list-outside so "10." and "100." render fully (no clipping).
  ul: ({ children }) => (
    <ul className="mb-2 pl-6 list-disc list-outside space-y-0.5">{children}</ul>
  ),
  // Contract: ordered-list marker width grows with item count. pl-6 fits up to
  // 2-digit markers; pl-9 adds ~12px for the 3-digit "100."/"183." width.
  // react-markdown passes `start` (the first item's start number) as a prop;
  // we count children to infer the max marker width rather than relying on
  // `start` alone, because a list could start at 90 and grow past 100.
  ol: ({ children, start }) => {
    const count = Array.isArray(children) ? children.length : 1;
    const maxIndex = (typeof start === 'number' ? start : 1) + count - 1;
    const padding = maxIndex >= 100 ? 'pl-9' : 'pl-6';
    return (
      <ol className={`mb-2 ${padding} list-decimal list-outside space-y-0.5`}>{children}</ol>
    );
  },
  li: ({ children }) => <li className="text-[15px] leading-relaxed">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-brand/50 pl-3 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => {
    // Only allow safe URL schemes: https, http, root-relative paths, and anchor links.
    const isSafe = href && /^(https?:\/\/|\/(?!\/)|#)/i.test(href);
    return isSafe ? (
      <a
        href={href}
        className="text-brand underline underline-offset-2 hover:text-brand/80"
        target="_blank"
        rel="noopener noreferrer"
      >
        {children}
      </a>
    ) : (
      <span className="text-muted-foreground">{children}</span>
    );
  },
  strong: ({ children }) => (
    <strong className="font-semibold text-foreground">{children}</strong>
  ),
  em: ({ children }) => <em className="italic text-muted-foreground">{children}</em>,
  hr: () => <hr className="my-3 border-border" />,
  // P1-9 + design pass 3: focusable labelled scroll region; horizontal scroll
  // (no-wrap short cells, edge fade) is the narrow-screen behaviour.
  table: ({ children }) => <ScrollTable>{children}</ScrollTable>,
  thead: ({ children }) => (
    <thead className="bg-secondary text-secondary-foreground">{children}</thead>
  ),
  th: ({ children }) => (
    // min-w-[80px] ensures cells are keyboard-reachable wide on mobile (P1-9).
    <th className={cn('px-3 py-1.5 text-left font-medium min-w-[80px]', cellClass(children))}>{children}</th>
  ),
  td: ({ children }) => (
    <td className={cn('border-t border-border px-3 py-1.5 min-w-[80px]', cellClass(children))}>{children}</td>
  ),
  code: ({ children, className }) => {
    const lang = /language-(\w+)/.exec(className ?? '')?.[1];
    // Block code (inside pre) is handled by the `pre` renderer below.
    return lang ? (
      <code className={cn('text-xs', className)}>{children}</code>
    ) : (
      <code className="rounded bg-secondary px-1 py-0.5 font-mono text-[11px] text-foreground">
        {children}
      </code>
    );
  },
  pre: ({ children }) => {
    // Extract language and raw code text from the nested <code> element that
    // react-markdown wraps inside <pre> for fenced code blocks.
    const codeEl = children as React.ReactElement<{
      className?: string;
      children?: React.ReactNode;
    }> | null;
    const lang = /language-(\w+)/.exec(codeEl?.props?.className ?? '')?.[1];
    const code = String(codeEl?.props?.children ?? '').replace(/\n$/, '');
    return <CodeBlock code={code} language={lang} />;
  },
};

/**
 * Renders markdown with GFM support (tables, task lists, strikethrough).
 *
 * P1-8: prose is capped at max-w-[70ch] for comfortable ~70-char line length
 * at 1440px. Tables and code blocks are allowed to overflow via their own
 * overflow-x-auto wrappers.
 */
export const MarkdownContent = memo(function MarkdownContent({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={cn('text-[15px] text-foreground max-w-[70ch]', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
