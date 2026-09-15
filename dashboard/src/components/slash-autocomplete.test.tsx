import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SlashCommand } from '@/types/api';
import { SlashAutocomplete } from './slash-autocomplete';

const COMMANDS: SlashCommand[] = [
  { name: '/afk', summary: 'Start an AFK session' },
  { name: '/review', summary: 'Review the current changes' },
];

beforeAll(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe('SlashAutocomplete', () => {
  it('matches a bare query against slash-prefixed command names', () => {
    render(
      <SlashAutocomplete
        query="af"
        commands={COMMANDS}
        onSelect={vi.fn()}
        visible
      />,
    );

    expect(screen.getByRole('option', { name: /\/afk/i })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /\/review/i })).not.toBeInTheDocument();
  });

  it('displays bare command names with one leading slash', () => {
    render(
      <SlashAutocomplete
        query="af"
        commands={[{ name: 'afk', summary: 'Start an AFK session' }]}
        onSelect={vi.fn()}
        visible
      />,
    );

    expect(screen.getByText('/afk')).toBeInTheDocument();
    expect(screen.queryByText('//afk')).not.toBeInTheDocument();
  });
});
