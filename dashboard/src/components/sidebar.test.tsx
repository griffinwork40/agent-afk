import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { Brain } from 'lucide-react';
import { Sidebar } from './sidebar';
import { registerNavItem } from '@/lib/nav-registry';

const props = {
  sessions: [], pendingSessionIds: new Set<string>(), selectedSessionId: null,
  onSelectSession: vi.fn(), activeNav: 'sessions', onNavChange: vi.fn(),
  collapsed: false, onToggleCollapse: vi.fn(),
};

describe('Sidebar navigation', () => {
  it('retains the built-in order and dispatches navigation by id', () => {
    render(<Sidebar {...props} />);
    const nav = screen.getByRole('navigation');
    expect(within(nav).getAllByRole('button').map((button) => button.textContent)).toEqual(['Sessions', 'Memory', 'Schedules', 'Jobs', 'Handoffs', 'Settings']);
    fireEvent.click(screen.getByRole('button', { name: 'Jobs' }));
    expect(props.onNavChange).toHaveBeenCalledWith('jobs');
    expect(screen.getByRole('button', { name: 'Sessions' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('No sessions found')).toBeInTheDocument();
  });

  it('retains accessible names and hides session list when collapsed or off Sessions', () => {
    const { rerender } = render(<Sidebar {...props} collapsed />);
    expect(screen.getByRole('button', { name: 'Memory' })).toHaveAttribute('title', 'Memory');
    expect(screen.queryByText('No sessions found')).toBeNull();
    rerender(<Sidebar {...props} activeNav="memory" />);
    expect(screen.queryByText('No sessions found')).toBeNull();
  });

  it('renders a registered entry without modifying sidebar code', () => {
    registerNavItem({ id: 'extension', label: 'Extension', title: 'Extension', icon: Brain });
    render(<Sidebar {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Extension' }));
    expect(props.onNavChange).toHaveBeenCalledWith('extension');
  });
});
