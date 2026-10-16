import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vite 8 (rolldown) ignores the esbuild option; JSX in UI tests transforms
  // through oxc with the automatic runtime.
  oxc: { jsx: { runtime: 'automatic' } },
  resolve: {
    alias: {
      // Mirror apps/web tsconfig paths so UI tests resolve like the app.
      '@': fileURLToPath(new URL('./apps/web/src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/web/src/**/*.test.{ts,tsx}',
      'tests/**/*.test.ts',
    ],
    // The golden-fixture/reducer suites are deterministic but CPU-heavy
    // (full fixture regeneration, reducer replays, CLI subprocesses). 30 s
    // keeps them stable on busy developer machines; fast CI runners finish
    // in a fraction of it. Explicit per-test timeouts still override this.
    testTimeout: 30_000,
  },
});
