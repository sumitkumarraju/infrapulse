import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': fileURLToPath(new URL('../shared', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    globals: true,
    include: ['test/**/*.test.ts'],
    // Seeding 1,108 segments takes a moment on a cold repository.
    testTimeout: 30_000,
  },
})
