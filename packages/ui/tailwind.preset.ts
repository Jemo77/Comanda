import type { Config } from 'tailwindcss';

/**
 * Preset de Tailwind v4.
 *
 * En Tailwind v4 el tema se define con `@theme` en CSS (ver styles.css). Este
 * preset solo agrega lo que CSS no puede expresar: variantes propias del
 * producto y fuentes tipograficas con respaldo.
 */
export default {
  content: [],
  theme: {
    extend: {
      fontFamily: {
        display: ['Archivo', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      borderRadius: {
        wire: '2px',
        panel: '3px',
      },
      colors: {
        enamel: '#e4e7ea',
        'enamel-deep': '#d7dce1',
        tile: '#f2f4f6',
        steel: '#cdd3d8',
        'steel-dark': '#a8b1b9',
        ink: '#14181c',
        'ink-soft': '#5a646e',
        'ink-faint': '#838d96',
        azulejo: '#1f5fa9',
        'azulejo-deep': '#17497f',
        'azulejo-soft': '#dce7f4',
        coca: '#c1272d',
        'coca-deep': '#9b1f24',
        'coca-soft': '#f7e2e2',
        abierto: '#1b7a4b',
        caution: '#d89b12',
      },
      minHeight: {
        touch: '48px',
      },
      minWidth: {
        touch: '48px',
      },
    },
  },
  plugins: [],
} satisfies Config;
