// Configuracion de Playwright para los flujos criticos del POS.
//
// El POS se prueba solo en Chromium porque es el unico motor con WebUSB/ESC-POS, que es
// como se imprime en un local real. Los otros navegadores quedan para Fase 1.

import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  // El POS es una PWA con IndexedDB y cola de outbox: los tests comparten estado
  // en el navegador y correrlos en paralelo los vuelve flaky.
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: process.env.POS_URL ?? 'http://localhost:5173',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: process.env.CI
    ? undefined
    : {
        command: 'pnpm dev',
        url: 'http://localhost:5173',
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
