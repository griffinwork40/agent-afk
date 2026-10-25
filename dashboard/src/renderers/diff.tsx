import type { CommandOutputBlock } from '@/types/command-wire';
import { cn } from '@/lib/utils';

/** Render untrusted diff as React text; +/- markers retain meaning without color. */
export function renderDiff(block: CommandOutputBlock) {
  if (block.kind !== 'diff') return <span>{block.text}</span>;
  return (
    <div>
      {block.fileName && <h3 className="mb-2 font-medium text-foreground">{block.fileName}</h3>}
      <pre className="max-w-full overflow-x-auto rounded border border-border p-2 text-xs" aria-label={block.fileName ? `Diff for ${block.fileName}` : 'Diff'} tabIndex={0}>
        <code>{block.diff.split('\n').map((line, i, lines) => (
          <span key={i} className={cn(
            line.startsWith('+') && !line.startsWith('+++') && 'bg-status-done/10 text-status-done',
            line.startsWith('-') && !line.startsWith('---') && 'bg-status-failed/10 text-status-failed',
            (line.startsWith('@@') || line.startsWith('+++') || line.startsWith('---')) && 'text-muted-foreground',
          )}>{line}{i < lines.length - 1 ? '\n' : ''}</span>
        ))}</code>
      </pre>
    </div>
  );
}
