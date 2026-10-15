import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vite 8 (rolldown) ignores the esbuild option; JSX in UI tests transforms
  // through oxc with the automatic runtime.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/web/src/**/*.test.{ts,tsx}',
      'tests/**/*.test.ts',
    ],
  },
});
