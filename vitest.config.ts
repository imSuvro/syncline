import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@syncline/protocol': src('./packages/protocol/src/index.ts'),
      '@syncline/client': src('./packages/client/src/index.ts'),
      '@syncline/server': src('./packages/server/src/index.ts'),
      'syncline-harness': src('./packages/harness/src/index.ts'),
      'syncline-demo-schema': src('./packages/demo-schema/src/index.ts'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
  },
});
