// @syncline/protocol — everything both sides must agree on, as pure data
// and pure functions: frame types + strict codecs (ADR-002), the permission
// ruleset + evaluator (ADR-003), and per-field LWW merge (ADR-005).
export * from './types.js';
export * from './frames.js';
export * from './rules.js';
export * from './merge.js';
