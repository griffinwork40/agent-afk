import { type ClassValue, clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Merge Tailwind classes with conflict resolution. shadcn/ui convention. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
