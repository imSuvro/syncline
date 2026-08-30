# ADR-001 — Sans-IO cores and the effect model

- Status: Accepted
- Date: 2026-08-29
- Deciders: Suvra Samajder

## Context

The stage-14 harness must run N clients + server through seeded, exactly
reproducible interleavings — offline/online churn, crashes, revocation
mid-sync — and replay any failing seed byte-identically. That is only
possible if business logic never touches wall clocks, RNG, IO, or scheduling
directly. The same boundary is what lets one server core run unchanged under
Cloudflare Durable Objects, a local Node process, and an in-process test
world (the "one adapter directory" constraint).

## Decision

Both cores are **sans-IO state machines**: plain functions over caller-owned
state that consume explicit inputs and return ordered effect lists. All
nondeterminism enters through inputs or injected environments; all outward
action leaves as effects executed by a thin runtime.

### Client core (`packages/client/src/core`)

```
createClient(config)                      -> ClientState
clientStep(state, input)                  -> Effect[]      // mutates state in place
```

Inputs: `localMutation` (op payload; row ids supplied by the caller),
`serverMessage`, `storageLoaded` (recovery snapshot at boot),
`connectivityChanged`, `timerFired {kind, now}`, `queryChanged`
(register/unregister reactive queries). Every input carries `now` (ms,
supplied by the environment — the core never reads a clock).

Effects, ordered: `storageWrite {records}`, `storageBarrier {id}`,
`send {msg}`, `setTimer {kind, afterMs}` / `clearTimer {kind}`,
`notifyQueries {ids}`, `emitEvent {…}` (membership-removed, upgrade-required —
the UI event surface).

**Client storage is asynchronous and effect-based** (IndexedDB): the runtime
must complete every `storageWrite` up to a `storageBarrier` durably before
executing any later `send` that the barrier precedes. The crash model the
harness exercises: writes after the last completed barrier may vanish; the
core must recover to a consistent state from any barrier boundary. This is
what makes "durable outbox" a tested property: an op is barriered before it
is ever pushed.

### Server core (`packages/server/src/core`)

One `WorkspaceCore` per workspace, plus a small `DirectoryCore`:

```
createWorkspace(config, deps)             -> WorkspaceState
workspaceStep(state, input, deps)         -> Effect[]
rehydrateConnection(state, attachment)    -> void          // post-hibernation
```

Inputs: `connect {connId, principal, hello}`, `message {connId, msg}`,
`disconnect {connId}`, `alarmFired`. All carry `now`.

Effects: `send {connId, msg}`, `close {connId, code}`, `setAlarm {atMs}`,
`setAttachment {connId, blob}` (hibernation survival, ADR-007).

**Server storage is synchronous and injected, not effect-based.** `deps`
carries the `ServerStorage` port (ADR-007) and `Env {newId()}`; the core
calls storage directly mid-step. **Inputs are the only time source** — `Env`
deliberately has no clock, so a step cannot observe two different `now`s.

## Options considered

**Effect-based server storage** (symmetric with the client) — rejected: both
production backends (Durable Object SQLite and `node:sqlite`) are
synchronous, so effect-plumbing async storage would turn every handler into
a continuation machine for zero testability gain; the in-memory fake is a
few Maps either way. Determinism holds because storage is itself
deterministic given call order. Durability ordering is the adapter's
contract: writes must be durable before any `send` from the same step is
released (Durable Objects' output gate provides exactly this; the Node
adapter commits its SQLite transaction before flushing sends).

**Immutable-reducer cores** — rejected on the raftlab evidence: full-copy
states are O(n²) at fuzz scale. Cores mutate in place; the harness snapshots
via explicit `cloneState` helpers where it needs frames.

**OO cores with injected clock/socket objects** — rejected: effects-as-data
make every decision inspectable and assertable in tests ("persist precedes
send" is an array-order check, not a mock-call-order dance).

## Consequences

- The harness drives both cores in-process with fake transport/storage and
  virtual time; stage 14 is an assembly job, not a rewrite.
- The determinism lint ban (`Date.now`, `Math.random`, timers, `node:` and
  DOM imports) applies to `protocol/src`, `client/src/core`, `server/src`,
  `harness/src` (CLI carve-out) and is CI-enforced from stage 7.
- Ids: server seq and client op ids are core-internal counters; row ids and
  workspace/user ids are generated at the edges (`Env.newId()` / the caller)
  so cores stay deterministic. The device `clientId` (ADR-002) enters the
  client core via `createClient(config)` — the browser runtime mints and
  persists it; the harness supplies deterministic ones.
- The cost: adapters must honor the barrier/output-gate contracts exactly;
  the harness's crash fault exists to catch any adapter that lies.
