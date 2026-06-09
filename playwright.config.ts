import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  workers: 1,
  fullyParallel: false,
  use: {
    baseURL: 'http://localhost:3000'
  },
  webServer: {
    // PULSE_AGENT_FAKE=1 → deterministic agent driver (no real LLM/network).
    // PULSE_PROVISION_FAKE=1 → deterministic provider boundary (no Jellyfin/seerr HTTP):
    //   onboarding provisions synthetic ids and federated login validates against the fake.
    // PULSE_DISABLE_POLLER=1 → no background event poller noise during e2e.
    command:
      'npm run build && PULSE_DB=./data/e2e.sqlite ORIGIN=http://localhost:3000 ' +
      'PULSE_AGENT_FAKE=1 PULSE_PROVISION_FAKE=1 PULSE_DISABLE_POLLER=1 node build',
    port: 3000,
    reuseExistingServer: false
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] }
    }
  ]
});
