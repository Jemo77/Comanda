import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Combina clases condicionales y resuelve conflictos de Tailwind.
 *
 * Sin el merge, un componente con `px-3` interno no puede ser sobreescrito por
 * `px-6` desde afuera: gana la que aparece despues en el CSS, no la que el
 * consumidor pide. Con `tailwind-merge`, la clase externa gana siempre, que es
 * lo esperable en un design system.
 */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
