import { defineConfig } from 'vitest/config';

// Project page lives at https://<user>.github.io/kubernetes-linter/, so assets
// must be requested relative to that sub-path rather than the domain root.
export default defineConfig({
  base: process.env['VITE_BASE'] ?? '/kubernetes-linter/',
  build: { target: 'es2022' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
