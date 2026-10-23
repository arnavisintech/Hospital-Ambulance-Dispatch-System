import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/** tailwind-merge aware of our custom tokens so `cn('shadow-card', 'shadow-raised')` keeps only the last. */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      shadow: [{ shadow: ['card', 'raised', 'sheet', 'focus'] }],
      'font-size': [{ text: ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl'] }],
      z: [{ z: ['map', 'map-overlay', 'sticky', 'sheet', 'modal', 'toast'] }],
    },
  },
});

/** Compose class names: conditional (clsx) + conflict-resolving (tailwind-merge). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
