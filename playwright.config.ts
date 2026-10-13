import { join } from 'node:path'
import { defineConfig } from '@playwright/test'
import { archiveFailures } from './tests/support/archiveResults.ts'

// Playwright clears test-results/ before a run. Keep the previous run's
// failures first: they move to test-results-archive/<timestamp>/ (newest 10
// kept). Only the runner does this; test workers load this file too.
if (process.env['TEST_WORKER_INDEX'] === undefined) {
  archiveFailures({
    resultsDir: join(import.meta.dirname, 'test-results'),
    archiveDir: join(import.meta.dirname, 'test-results-archive'),
  })
}

// E2E tests launch the built (unpackaged) Electron app; run pnpm build:app first.
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
})
