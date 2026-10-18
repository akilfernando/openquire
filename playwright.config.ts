import { defineConfig, devices } from '@playwright/test'

export default defineConfig({
  testDir: 'e2e',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
    // Workspace tests start after setup; onboarding.spec.ts covers fresh profiles.
    storageState: {
      cookies: [],
      origins: [{
        origin: 'http://localhost:4173',
        localStorage: [{ name: 'openquire.onboarded', value: 'true' }],
      }],
    },
    // Service workers would cache between tests; they're covered by a dedicated test.
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    ...(['firefox', 'webkit'] as const).map(name => ({
      name,
      // Focused engine, save/import and keyboard coverage before expanding the
      // full Chromium suite. Touch-device emulation is not supported in Firefox.
      testMatch: ['desktop-updates.spec.ts', 'ai-discovery.spec.ts', 'onboarding.spec.ts', 'ai-providers.spec.ts', 'tool-discovery.spec.ts', 'home.spec.ts', 'baselines.spec.ts', 'import-files.spec.ts', 'document-lifecycle.spec.ts', 'keyboard.spec.ts'],
      use: { browserName: name, viewport: { width: 1440, height: 1000 } },
    })),
  ],
  webServer: {
    command: 'npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
  },
})
