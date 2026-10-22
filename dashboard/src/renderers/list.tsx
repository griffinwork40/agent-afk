import type { CommandOutputBlock } from '@/types/command-wire';

export function renderList(block: CommandOutputBlock) {
  if (block.kind !== 'list') return <span>{block.text}</span>;
  return (
    <div>
      {block.title && <h3 className="mb-2 font-medium text-foreground">{block.title}</h3>}
      <ul className="list-disc space-y-1 pl-5">
        {block.items.map((item, i) => (
          <li key={i}>
            <span>{item.text}</span>
            {item.description && <p className="whitespace-pre-wrap text-muted-foreground">{item.description}</p>}
          </li>
        ))}
      </ul>
    </div>
  );
}
