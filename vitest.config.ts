import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only avocado's own tests — the A.C.A.S reference tree has its own suites
    // (chessgroundx etc.) that must not run here.
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
