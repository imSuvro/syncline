// Flat config: typescript-eslint strict everywhere, plus the determinism ban
// scoped to the sans-IO packages (ADR-001). Core/sync logic must receive
// time, randomness, ids, and IO through inputs and injected ports — never
// reach for them ambiently. The harness CLI may do IO but still no ambient
// clocks or randomness.
import tseslint from 'typescript-eslint';

const DETERMINISTIC = [
  'packages/protocol/src/**/*.ts',
  'packages/client/src/core/**/*.ts',
  'packages/server/src/**/*.ts',
  'packages/harness/src/**/*.ts',
  'packages/demo-schema/src/**/*.ts',
];

const banClocksAndRandom = {
  'no-restricted-globals': [
    'error',
    'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
    'setImmediate', 'queueMicrotask', 'requestAnimationFrame',
    'performance', 'crypto', 'process', 'indexedDB', 'fetch', 'WebSocket',
  ],
  'no-restricted-properties': [
    'error',
    { object: 'Date', property: 'now', message: 'Inputs carry now (ADR-001).' },
    { object: 'Math', property: 'random', message: 'Use the injected PRNG (ADR-001).' },
    { object: 'globalThis', property: 'setTimeout' },
    { object: 'globalThis', property: 'setInterval' },
    { object: 'globalThis', property: 'performance' },
    { object: 'globalThis', property: 'crypto' },
    { object: 'globalThis', property: 'process' },
    { object: 'globalThis', property: 'fetch' },
    { object: 'globalThis', property: 'indexedDB' },
  ],
  'no-restricted-syntax': [
    'error',
    { selector: "NewExpression[callee.name='Date'][arguments.length=0]", message: 'new Date() reads the wall clock (ADR-001).' },
    { selector: "CallExpression[callee.name='Date']", message: 'Date() reads the wall clock (ADR-001).' },
  ],
  'no-restricted-imports': [
    'error',
    { patterns: [{ group: ['node:*', 'fs', 'path', 'os', 'timers', 'timers/*', 'crypto', 'child_process', 'worker_threads', 'ws'], message: 'sans-IO code imports no platform modules (ADR-001).' }] },
  ],
};

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'docs/**', '**/*.js', '**/*.mjs', '**/.wrangler/**'] },
  ...tseslint.configs.strict.map((c) => ({ ...c, files: ['**/*.ts', '**/*.tsx'] })),
  { files: DETERMINISTIC, rules: banClocksAndRandom },
  {
    // The fuzz/repro CLI may touch files and stdio, but stays clock/random-clean.
    files: ['packages/harness/src/cli/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['ws'], message: 'CLI drives the in-process world, not sockets.' }] }],
      'no-restricted-globals': ['error', 'setTimeout', 'setInterval', 'fetch', 'WebSocket', 'indexedDB'],
    },
  },
);
