import { defineConfig } from '@playwright/test'
import workspace from './playwright.config'

export default defineConfig({
  ...workspace,
  testDir: 'benchmarks',
  outputDir: 'benchmark-results',
  timeout: 180_000,
  workers: 1,
  retries: 0,
  fullyParallel: false,
  reporter: 'list',
  use: {
    ...workspace.use,
    baseURL: 'http://localhost:4174',
    screenshot: 'only-on-failure',
    storageState: { cookies: [], origins: [{ origin: 'http://localhost:4174', localStorage: [{ name: 'openquire.onboarded', value: 'true' }] }] },
  },
  webServer: { command: 'npx vite preview --port 4174 --strictPort', url: 'http://localhost:4174', reuseExistingServer: false },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
})
