import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  root: '.',
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
  server: {
    port: 4318,
    proxy: {
      '/api': 'http://127.0.0.1:4317',
    },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/web/setup.ts'],
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    /**
     * Nine suites spawn a real subprocess — the ACP client, the run supervisor,
     * the realtime socket, the agent process adapter and others. Under the full
     * suite's parallelism, process spawn alone can exceed the 5s default on a
     * loaded machine, and suites then fail for a reason unrelated to what they
     * test. Raised once here rather than per file, because it kept recurring in
     * a different suite each time and the per-file fixes were drifting apart.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
