import { cn } from '@/lib/utils';

/** Renders a unified diff string with colored line backgrounds. */
export function DiffViewer({ diff }: { diff: string }) {
  const lines = diff.split('\n');

  return (
    <div className="overflow-x-auto rounded bg-secondary font-mono text-xs leading-5">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, i) => {
            const isAdd = line.startsWith('+') && !line.startsWith('+++');
            const isDel = line.startsWith('-') && !line.startsWith('---');
            const isHunk = line.startsWith('@@');
            const isMeta = line.startsWith('+++') || line.startsWith('---');

            return (
              <tr
                key={i}
                className={cn(
                  isAdd && 'bg-status-running/15 text-status-running',
                  isDel && 'bg-status-failed/15 text-status-failed',
                  isHunk && 'bg-muted text-muted-foreground',
                  isMeta && 'text-muted-foreground',
                  !isAdd && !isDel && !isHunk && !isMeta && 'text-foreground',
                )}
              >
                <td className="select-none px-2 py-0 text-right text-muted-foreground/50 tabular-nums">
                  {i + 1}
                </td>
                <td className="w-full whitespace-pre px-2 py-0">
                  {line || ' '}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
