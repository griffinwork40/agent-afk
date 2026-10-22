import type { CommandOutputBlock } from '@/types/command-wire';
import { cn } from '@/lib/utils';

export function renderLink(block: CommandOutputBlock) {
  if (block.kind !== 'link') return <span>{block.text}</span>;
  // Never turn javascript:, data:, or other executable/local schemes into links.
  let url: URL;
  try {
    url = new URL(block.url);
  } catch {
    return <span>{block.text}</span>;
  }
  if (!['https:', 'http:'].includes(url.protocol)) return <span>{block.text}</span>;
  return (
    <a href={url.href} target="_blank" rel="noopener noreferrer" className={cn('break-all text-primary underline underline-offset-2', 'rounded focus:outline-none focus:ring-1 focus:ring-ring')}>
      {block.label}
    </a>
  );
}
