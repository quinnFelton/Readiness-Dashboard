import { fileURLToPath } from 'node:url';
import { defineProject } from 'vitest/config';

export default defineProject({
  // Mirror tsconfig.json `paths` ("@/*" -> "./src/*") so tests can import modules that use it.
  resolve: {
    alias: { '@/': fileURLToPath(new URL('./src/', import.meta.url)) },
  },
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
  },
});
