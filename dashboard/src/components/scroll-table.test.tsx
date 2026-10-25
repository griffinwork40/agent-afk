import { render } from '@testing-library/react';
import { expect, it } from 'vitest';
import { MarkdownContent } from './markdown-content';
import { cellClass, nodeText } from './scroll-table';

const md = [
  '| Runtime | Threading | Use case |',
  '|---|---|---|',
  '| tokio | Multi-threaded work-stealing | ' + 'A long prose cell that explains a lot of detail about when to pick it over others |',
].join('\n');

it('renders tables in a focusable labelled scroll region with short cells unwrapped', () => {
  const { container } = render(<MarkdownContent text={md} />);
  const region = container.querySelector('[role="region"][aria-label="data table"]') as HTMLElement;
  expect(region).toBeTruthy();
  expect(region.tabIndex).toBe(0);
  expect(region.className).toContain('overflow-x-auto');
  const cells = [...container.querySelectorAll('td')];
  expect(cells[0]!.className).toContain('whitespace-nowrap');
  expect(cells[1]!.className).toContain('whitespace-nowrap');
  // Long prose keeps a readable width and wraps instead of one huge line.
  expect(cells[2]!.className).toContain('min-w-[14rem]');
  expect(cells[2]!.className).not.toContain('whitespace-nowrap');
  expect(container.querySelector('table')!.className).toContain('text-xs');
  expect(container.querySelector('[data-edge-fade="right"]')).toBeTruthy();
});

it('nodeText/cellClass read nested inline content', () => {
  expect(nodeText(<span>a<b>bc</b>{1}</span>)).toBe('abc1');
  expect(cellClass('short')).toBe('whitespace-nowrap');
});
