import { defineConfig, devices } from '@playwright/test';

const app = process.env.E2E_REAL_APP_DIR;
const database = process.env.E2E_REAL_DATABASE_URL;
const uploads = process.env.E2E_REAL_STORAGE_DIR;
const provider = process.env.E2E_REAL_PROVIDER_URL;
if (!app || !database || !uploads || !provider?.startsWith('http://127.0.0.1:')) {
  throw new Error('Run real-mode UI regression through npm run test:e2e:real');
}
export default defineConfig({
  testDir: 'tests/e2e', testMatch: 'demo-real.spec.ts', outputDir: 'test-results/real', workers: 1, timeout: 90_000,
  use: { baseURL: 'http://127.0.0.1:3001', ...devices['Desktop Chrome'],
    launchOptions: { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe' } },
  webServer: { command: 'node scripts/test-e2e-real.mjs --serve', url: 'http://127.0.0.1:3001',
    reuseExistingServer: false, timeout: 120_000,
    env: { E2E_REAL_APP_DIR: app, DATABASE_URL: database, PRIVATE_STORAGE_DIR: uploads,
      DEMO_MODE: '1', MODEL_PROVIDER: 'glm', MODEL_API_KEY: 'local-synthetic-e2e-key',
      MODEL_BASE_URL: provider, MODEL_NAME: 'synthetic-text', MODEL_VISION_NAME: 'synthetic-vision',
      NEXT_TELEMETRY_DISABLED: '1' } },
});
