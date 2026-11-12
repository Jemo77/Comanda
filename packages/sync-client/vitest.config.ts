import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    // Node, no jsdom: el cliente de sincronizacion es isomorfico y el storage de
    // pruebas esta en memoria. Los tests corren en milisegundos, sin navegador.
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // `fake-indexeddb` tiene que estar cargado antes que Dexie: Dexie busca el
    // `indexedDB` global en el momento de abrir la base, no en el de importar.
    setupFiles: ['src/setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/index.ts',
        'src/testing.ts',
        // `protocol.ts` y `storage.ts` son contratos: en JS emit se reducen a
        // los enums y a las constantes. Medir la cobertura de archivos sin codigo
        // ejecutable baja el numero sin que haya nada sin probar.
        'src/protocol.ts',
        'src/storage.ts',
      ],
      thresholds: {
        // El plan exige 80% en dominio y pricing-engine. El motor de sync esta
        // en la misma categoria: es donde un hueco de cobertura es un cobro
        // perdido.
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
