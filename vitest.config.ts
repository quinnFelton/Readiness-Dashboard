import { defineConfig } from 'vitest/config';

// Root runner: `pnpm test` runs every package's own vitest.config.ts as a project (including the
// CDK assertion tests in infra/cdk).
export default defineConfig({
  test: {
    projects: ['apps/*', 'packages/*', 'infra/cdk'],
  },
});
