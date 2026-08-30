// syncline-harness — the deterministic world: virtual time, seeded PRNG
// streams, fake transport, a reference client, and (from stage 14) fault
// injection + invariant checkers + the fuzz campaign.
export { createRoot, fnv1a, type Rng } from './prng.js';
export { VirtualClock } from './vtime.js';
export { RefClient, type RefClientIo } from './refclient.js';
export { World, canonical, type WorldOptions } from './world.js';
export {
  InvariantViolation,
  runCampaign,
  type CampaignOptions,
  type CampaignResult,
} from './campaign.js';
export const HARNESS_VERSION = '0.1.0';
