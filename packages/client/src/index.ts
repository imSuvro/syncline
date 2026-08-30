// @syncline/client — the sans-IO sync core (src/core, ADR-001) plus thin
// browser adapters (src/adapters). The core is what the harness fuzzes;
// the adapters are what the demo app touches.
export * from './core/types.js';
export { clientStep, createClient, decodeStored } from './core/engine.js';
export { pendingCount, queryTable, type ViewRow } from './core/view.js';
export { SynclineClient, type SynclineClientOptions } from './adapters/runtime.js';
export const CLIENT_VERSION = '0.1.0';
