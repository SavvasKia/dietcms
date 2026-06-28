import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.test.ts'],
    globals: true,
    testTimeout: 30000,
    setupFiles: ['./vitest.integration.setup.ts'],
  },
  resolve: { alias: { '@': resolve(__dirname, '.') } },
})
