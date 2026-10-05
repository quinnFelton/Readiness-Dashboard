import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    // Several DB test files serialise on one advisory lock (src/test-utils/defaults-mutex.ts,
    // providers/oura/test-mutex.ts) in their beforeAll; with ~100 files in parallel the last one can
    // wait longer than vitest's 10 s default for the earlier holders to finish.
    hookTimeout: 60_000,
  },
});
