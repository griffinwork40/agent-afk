import type { CommandOutputBlock } from '@/types/command-wire';
import { cn } from '@/lib/utils';

export function renderTable(block: CommandOutputBlock) {
  if (block.kind !== 'table') return <span>{block.text}</span>;
  return (
    <div className={cn('max-w-full overflow-x-auto rounded border border-border', 'focus:outline-none focus:ring-1 focus:ring-ring')} role="region" aria-label={block.title ?? 'Command table'} tabIndex={0}>
      <table className="w-full text-left text-sm">
        {block.title && <caption className="px-3 py-2 text-left font-medium text-foreground">{block.title}</caption>}
        <thead className="bg-muted/50 text-muted-foreground">
          <tr>{block.columns.map((column, i) => <th key={i} scope="col" className="whitespace-nowrap px-3 py-2 font-medium">{column}</th>)}</tr>
        </thead>
        <tbody>{block.rows.map((row, i) => (
          <tr key={i} className="border-t border-border/50">
            {row.map((cell, j) => <td key={j} className="whitespace-pre-wrap px-3 py-2 align-top">{cell}</td>)}
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}
