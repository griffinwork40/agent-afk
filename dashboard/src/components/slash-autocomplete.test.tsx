import { render, screen } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { SlashCommand } from '@/types/api';
import { SlashAutocomplete, handleAutocompleteKey } from './slash-autocomplete';

const COMMANDS: SlashCommand[] = [
  { name: '/afk', summary: 'Start an AFK session', kind: 'skill', web: 'ok' },
  { name: '/review', summary: 'Review the current changes', kind: 'skill', web: 'ok' },
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
        commands={[{ name: 'afk', summary: 'Start an AFK session', kind: 'skill', web: 'ok' }]}
        onSelect={vi.fn()}
        visible
      />,
    );

    expect(screen.getByText('/afk')).toBeInTheDocument();
    expect(screen.queryByText('//afk')).not.toBeInTheDocument();
  });
});

describe('handleAutocompleteKey', () => {
  const key = (k: string) => ({ key: k }) as unknown as import('react').KeyboardEvent;

  it('Enter completes a partial match', () => {
    const onConfirm = vi.fn();
    expect(handleAutocompleteKey(key('Enter'), true, 3, 1, vi.fn(), onConfirm, vi.fn(), false)).toBe(true);
    expect(onConfirm).toHaveBeenCalledWith(1);
  });

  it('Enter falls through to submit when the typed token already equals the active suggestion', () => {
    const onConfirm = vi.fn();
    expect(handleAutocompleteKey(key('Enter'), true, 3, 0, vi.fn(), onConfirm, vi.fn(), true)).toBe(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('Tab always completes, even on an exact match', () => {
    const onConfirm = vi.fn();
    expect(handleAutocompleteKey(key('Tab'), true, 3, 2, vi.fn(), onConfirm, vi.fn(), true)).toBe(true);
    expect(onConfirm).toHaveBeenCalledWith(2);
  });
});
