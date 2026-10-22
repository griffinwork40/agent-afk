import { Fragment } from 'react';
import type { CommandOutputBlock } from '@/types/command-wire';

export function renderKeyValue(block: CommandOutputBlock) {
  if (block.kind !== 'keyValue') return <span>{block.text}</span>;
  return (
    <div>
      {block.title && <h3 className="mb-2 font-medium text-foreground">{block.title}</h3>}
      <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-1">
        {block.entries.map((entry, i) => (
          <Fragment key={i}>
            <dt className="text-muted-foreground">{entry.key}</dt>
            <dd className="whitespace-pre-wrap break-words">{entry.value}</dd>
          </Fragment>
        ))}
      </dl>
    </div>
  );
}
