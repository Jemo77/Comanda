import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * Configuracion del POS.
 *
 * Cuatro decisiones con motivo:
 *
 *  1. **`@tailwindcss/vite` es obligatorio, no opcional.** Tailwind v4 no es un
 *     `postcss.config.js`: es un plugin que escanea el codigo fuente y **genera las
 *     utilidades**. Sin el, `@import 'tailwindcss'` solo emite las variables de
 *     `--color-*` y `--font-*`, y ninguna clase como `flex` o `bg-enamel` existe en
 *     el CSS final. El resultado compila sin error y se ve sin diseno: el POS
 *     entero como texto negro sobre blanco.
 *
 *     Es el fallo mas caro del repo porque es silencioso: el build pasa, los tests
 *     pasan (el de humo busca un `h1`, y el texto esta), y el problema aparece
 *     unicamente mirando la pantalla.
 *
 *  2. **Los tokens van en `@theme` de CSS, no en un `tailwind.config`.** Ver
 *     `packages/ui/src/styles.css` y `docs/DESIGN.md`.
 *
 *  3. **`optimizeDeps.exclude` para `@comanda/ui`.** Es codigo fuente TS, no un
 *     paquete publicado. Si Vite lo pre-empaquetara, los estilos travelling del
 *     design system se duplicarian y los tokens quedarian desactualizados.
 *
 *  4. **Presupuesto de bundle.** El POS se descarga una vez y tiene que arrancar en
 *     un local con internet lenta. Los 300 KB son un limite duro del plan.
 */
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg'],
      workbox: {
        // El shell se precachea entero: sin internet, el POS tiene que abrir igual.
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
        navigateFallback: 'index.html',
        // La API NUNCA se cachea: una respuesta vieja de catalogo o precios seria
        // peor que un error de red, porque el mozo cobraria mal sin darse cuenta.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.startsWith('/api/'),
            handler: 'NetworkOnly',
          },
        ],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
      manifest: {
        name: 'Comanda POS',
        short_name: 'Comanda',
        description: 'Punto de venta para bares y cafes',
        theme_color: '#14181c',
        background_color: '#e4e7ea',
        display: 'standalone',
        orientation: 'landscape',
        // El mostrador suele tener la tablet en vertical, pero el ticket y la
        // columna de cobro se leen mejor apaisados.
        start_url: '/',
      },
      devOptions: { enabled: false },
    }),
  ],

  resolve: {
    alias: {
      '@': '/src',
    },
  },

  optimizeDeps: {
    exclude: ['@comanda/ui'],
  },

  server: {
    port: 5173,
    strictPort: true,
  },

  build: {
    target: 'es2022',
    sourcemap: true,
    // El limite es del plan (300 KB gzip). Vite avisa en 500 KB, pero el presupuesto
    // real se controla en el pipeline con el tamano comprimido.
    chunkSizeWarningLimit: 300,
    rollupOptions: {
      output: {
        // Separar lo que cambia seguido de lo que no: una correccion de estilo del
        // design system no deberia invalidar la cache del codigo de venta.
        manualChunks: {
          vendor: ['react', 'react-dom'],
          data: ['dexie'],
        },
      },
    },
  },
});
