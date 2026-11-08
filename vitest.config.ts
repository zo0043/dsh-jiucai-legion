import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'python/**/*.test.ts'],
    environment: 'node',
    testTimeout: 30000,
  },
});
