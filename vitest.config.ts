import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'tests/support/**/*.test.ts',
      'scripts/**/*.test.mjs',
    ],
    environment: 'node',
  },
})
