import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // Synth + (optional) esbuild bundling is slower than a unit test.
    testTimeout: 120_000,
  },
});
