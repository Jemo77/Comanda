import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Configuracion del backoffice.
 *
 * Difiere del POS en dos cosas, y las dos importan:
 *
 *  1. **Orientacion y viewport.** El admin se usa en una notebook o en un celular del
 *     dueño, mirando la pantalla un rato: no hay restriccion de apaisado.
 *
 *  2. **`optimizeDeps.exclude` para `@comanda/ui`.** Es codigo fuente TS. Si Vite lo
 *     pre-empaquetara, los estilos travelling del design system quedarian duplicados.
 *
 * `@tailwindcss/vite` es obligatorio y no es decorativo: Tailwind v4 genera las
 * utilidades escaneando el codigo, asi que sin el plugin el build emite solo las
 * variables de tema y ninguna clase existe en el CSS final. Compila sin error y se
 * ve sin diseno. Ver la nota larga en `apps/pos/vite.config.ts`.
 */
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: 'index.html',
        runtimeCaching: [
          {
            // La API nunca se cachea. En el admin eso importa mas que en el POS: una
            // lista de precios vieja seria un precio mal mostrado en una pantalla de
            // configuracion, que es donde se decide cuanto cobra el local.
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
          },
        ],
      },
      manifest: {
        name: 'Comanda Backoffice',
        short_name: 'Comanda',
        description: 'Configuración y backoffice de Comanda',
        theme_color: '#14181c',
        background_color: '#e4e7ea',
        display: 'standalone',
      },
      devOptions: { enabled: false },
    }),
  ],

  resolve: {
    alias: { '@': '/src' },
  },

  optimizeDeps: {
    exclude: ['@comanda/ui'],
  },

  server: {
    port: 5174,
    strictPort: true,
  },

  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: { vendor: ['react', 'react-dom'] },
      },
    },
  },
});
