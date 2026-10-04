import { defineConfig } from 'vitest/config';

// Root runner: `pnpm test` runs every package's own vitest.config.ts as a project.
export default defineConfig({
  test: {
    projects: ['apps/*', 'packages/*'],
  },
});
