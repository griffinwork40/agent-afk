import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';
import type { Components } from 'react-markdown';
import { CodeBlock } from './code-block';

const components: Components = {
  h1: ({ children }) => <h1 className="mb-3 text-xl font-bold">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 text-lg font-semibold">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1.5 text-base font-semibold">{children}</h3>,
  p: ({ children }) => <p className="mb-2 last:mb-0 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="mb-2 ml-4 list-disc space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2 ml-4 list-decimal space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="text-sm">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="mb-2 border-l-2 border-brand/50 pl-3 italic text-muted-foreground">
      {children}
    </blockquote>
  ),
  a: ({ href, children }) => {
    // Only allow safe URL schemes: https, http, root-relative paths, and anchor links.
    // Anything else (data:, javascript:, vbscript:, …) renders as plain text.
    const isSafe = href && /^(https?:\/\/|\/(?!\/)|#)/i.test(href);
    return isSafe ? (
      <a href={href} className="text-brand underline underline-offset-2 hover:text-brand/80" target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span className="text-muted-foreground">{children}</span>
    );
  },
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic text-muted-foreground">{children}</em>,
  hr: () => <hr className="my-3 border-border" />,
  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto rounded border border-border">
      <table className="w-full text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-secondary text-secondary-foreground">{children}</thead>,
  th: ({ children }) => <th className="px-3 py-1.5 text-left font-medium">{children}</th>,
  td: ({ children }) => <td className="border-t border-border px-3 py-1.5">{children}</td>,
  code: ({ children, className }) => {
    const lang = /language-(\w+)/.exec(className ?? '')?.[1];
    // Block code (inside pre) is styled by the `pre` renderer; this handles inline.
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
    // react-markdown always wraps inside <pre> for fenced code blocks.
    const codeEl = children as React.ReactElement<{ className?: string; children?: React.ReactNode }> | null;
    const lang = /language-(\w+)/.exec(codeEl?.props?.className ?? '')?.[1];
    const code = String(codeEl?.props?.children ?? '').replace(/\n$/, '');
    return <CodeBlock code={code} language={lang} />;
  },
};

/** Renders markdown with GFM support (tables, task lists, strikethrough). */
export function MarkdownContent({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cn('text-sm text-foreground', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
