import { Bell, Brain, Briefcase, Calendar, MessageSquare, Settings, type LucideIcon } from 'lucide-react';

/** Navigation metadata, independent of the sidebar's presentation. */
export interface NavItem {
  id: string;
  label: string;
  title: string;
  icon: LucideIcon;
}

const registry = new Map<string, Readonly<NavItem>>();

/** Registration order is display order; replacing an item preserves its position. */
export function registerNavItem(item: NavItem): void {
  registry.set(item.id, Object.freeze({ ...item }));
}

export function getNavItem(id: string): Readonly<NavItem> | undefined {
  return registry.get(id);
}

export function listNavItems(): Readonly<NavItem>[] {
  return [...registry.values()];
}

[
  { id: 'sessions', label: 'Sessions', title: 'Sessions', icon: MessageSquare },
  { id: 'memory', label: 'Memory', title: 'Memory', icon: Brain },
  { id: 'schedules', label: 'Schedules', title: 'Schedules', icon: Calendar },
  { id: 'jobs', label: 'Jobs', title: 'Background Jobs', icon: Briefcase },
  { id: 'handoffs', label: 'Handoffs', title: 'Pending Handoffs', icon: Bell },
  { id: 'settings', label: 'Settings', title: 'Settings', icon: Settings },
].forEach(registerNavItem);
