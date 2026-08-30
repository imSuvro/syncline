import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Alias the workspace packages to source so the demo always builds against
// what the tests exercise (no stale dist in the loop).
const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@syncline/protocol': src('../../packages/protocol/src/index.ts'),
      '@syncline/client': src('../../packages/client/src/index.ts'),
      'syncline-demo-schema': src('../../packages/demo-schema/src/index.ts'),
    },
  },
  build: { outDir: 'dist', sourcemap: true },
});
