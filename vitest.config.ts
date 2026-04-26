import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,js}'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.d.ts',
        'src/types/**',
        'test/**',
        'coverage/**',
        'plugin/**'
      ],
      reportsDirectory: 'coverage'
    }
  }
})
