import type { CommandProgress as Progress } from '@/hooks/use-choice-progress';

/** Compact live command status. A progress 'end' event removes it from the view. */
export function CommandProgress({ progress }: { progress: Progress[] }) {
  if (!progress.length) return null;
  return <div aria-label="Command progress" className="mx-auto w-full max-w-4xl space-y-2 px-3 py-2">
    {progress.map(({ corrId, label, fraction }) => (
      <div key={corrId} role="status" aria-live="polite" className="rounded-md border bg-secondary/40 px-3 py-2 text-xs">
        <span>{label}</span>
        {fraction !== undefined && <progress className="mt-1 block w-full" value={fraction} max={1}
          aria-label={`${label} progress`} />}
      </div>
    ))}
  </div>;
}
