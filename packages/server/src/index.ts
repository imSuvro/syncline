// @syncline/server — deterministic workspace core and the one adapter
// boundary (ADR-001/007). Platform adapters (node, Cloudflare, harness)
// implement adapter.ts; nothing in here touches a platform.
export * from './adapter.js';
export * from './permit.js';
export * from './workspace.js';
export { createMemoryStorage } from './memory.js';
export const SERVER_VERSION = '0.1.0';
