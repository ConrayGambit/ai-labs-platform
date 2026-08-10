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
  },
});
