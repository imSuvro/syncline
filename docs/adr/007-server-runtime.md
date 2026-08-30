# ADR-007 — Server runtime: Durable Object topology and Node parity

- Status: Accepted
- Date: 2026-08-29
- Deciders: Suvra Samajder

## Context

ADR-000 chose Cloudflare Workers + SQLite-backed Durable Objects as the
hosting default. The brief requires all platform-specific code behind one
adapter interface so a hosting switch touches one directory. ADR-001 fixed
the core/adapter split; this ADR fixes the adapter contract and both
implementations.

## Decision

### The one adapter boundary — `packages/server/src/adapter.ts`

```ts
interface ServerStorage {          // SYNCHRONOUS (DO SQLite and node:sqlite both are)
  appendOp(entry): number;                       // assigns and returns seq
  getOpsSince(seq, limit): OpEntry[];
  getRow(table, rowId) / upsertRow / deleteRow;  // materialized rows w/ per-field seq
  scanRows(table): Row[];                        // snapshot path
  getMembership(userId) / putMembership / listMemberships;
  getClientMark(clientId) / setClientMark;        // push dedup high-water marks
  getEpoch(userId) / setEpoch;
  getMeta(key) / setMeta(key, value);             // schemaVersion, workspace meta
  tx<T>(fn: () => T): T;                          // atomicity for one core step
}
interface ConnectionHost {
  send(connId, text): void;
  close(connId, code): void;
  setAttachment(connId, blob): void;              // survives DO hibernation
}
interface AlarmHost { setAlarm(atMs): void; cancelAlarm(): void; }
interface DirectoryPort { notifyMembership(change): void; }  // at-least-once, see below
interface Env { newId(): string; }   // no clock: inputs are the only time source (ADR-001)
```

Contract obligations on every adapter: (1) storage writes of a core step
are durable before that step's `send`s are released (Durable Objects'
output gate gives this natively; the Node adapter wraps each step in a
SQLite transaction committed before flushing sends); (2) `tx` is atomic —
a crash mid-step loses the whole step, never half.

### Cloudflare topology (`apps/server-cf`)

- **`WorkspaceDO`** — one per workspace, addressed by
  `idFromName(workspaceId)`. Holds everything for its workspace in DO
  SQLite: `ops` (seq-keyed log), `rows` (one SQLite row per domain row;
  fields as JSON with per-field seq stamps — one write per op),
  `memberships`, `client_marks`, `epochs`, `meta`. Serves the workspace's
  WebSockets via the **Hibernation API**: `acceptWebSocket()`, per-
  connection `serializeAttachment({connId, userId, clientId, epochAtHello})`
  — **non-authoritative identity cache only**: the permit path (ADR-003)
  never reads role or epoch from it; role comes from the membership row on
  every evaluation, and `epochAtHello` exists solely for the receive-time
  staleness check (ADR-004: mismatch with stored epoch → forget/`REVOKED`
  or `EPOCH_CHANGED` close). On wake, `webSocketMessage` rebuilds core
  connection state via `rehydrateConnection(attachment)` (ADR-001), and the
  first message runs that same check. Duration bills only while awake; the
  harness's hibernate fault (drop core memory, keep connections) keeps this
  path honest.
- **`DirectoryDO`** — singleton: demo users, workspace directory
  (id → name, membership summaries for the sidebar), login. `POST
  /auth/login {userId}` → JWT (HS256 via WebCrypto, secret from
  `wrangler secret put JWT_SECRET`, 24h expiry; claims `{sub, iat, exp}`).
  The token proves identity only — authorization is always live in the
  sync path (ADR-003/004). Details in ADR-008 at stage 8.

  **Membership propagation** (review finding — the invite flow's missing
  leg): when a WorkspaceCore applies a membership op, it emits a
  `notifyMembership` call on the injected `DirectoryPort`. Delivery is
  **at-least-once**: the change is also written to a `directory_outbox`
  row inside the same `tx`, retried via alarm until the directory acks,
  then deleted — the tx boundary is never widened across objects. The
  directory is an eventually-consistent denormalized view (authority stays
  in the WorkspaceDO); duplicates are idempotent upserts. Clients discover
  membership changes by refetching `/directory` at login, on any
  membership event on a live socket, and on a slow poll (30s) — so an
  invited user's sidebar gains the workspace within seconds without a
  reload (docs/ux.md re-invite beat).
- **Worker router**: `/auth/*`, `/directory` → DirectoryDO;
  `/ws/:workspaceId` → that WorkspaceDO (WebSocket upgrade). Static
  assets: none (demo is on Vercel).

Free-tier math (ADR-000 watch-item): one op costs 2–3 SQLite row writes
(op log + materialized row + occasional mark/meta) → the 100k writes/day
cap supports ~30–50k ops/day; the demo's scripted sessions are hundreds.
Client pushes batch ops per frame, keeping the 20:1 incoming-message
billing negligible.

### Node parity adapter (`packages/server-node`)

The primary local-dev and CI-integration server: one process,
`Map<workspaceId, WorkspaceCore>`, one `node:sqlite` `DatabaseSync` per
workspace (file or `:memory:`), `ws` for sockets, same JWT verification via
`node:crypto` webcrypto. Started as `pnpm dev:server` (Node 22 needs
`--experimental-sqlite`; fallback dependency `better-sqlite3` only if the
flag misbehaves). The demo's `VITE_SYNC_URL` points here in dev, at the
workers.dev URL in prod. Behavioral parity is enforced by running the same
harness scenario suite over an adapter-backed world in CI (stage 9+), not
by hope.

### The harness adapter (`packages/harness`)

In-memory fakes of the same interfaces (Maps + arrays), scheduled on
virtual time, with fault knobs (ADR-001). Three adapters, one contract,
zero platform types in `packages/server`.

## Options considered

- **D1 for storage + DO for sockets** — rejected: two products, two
  consistency domains, cross-object races the DO-local SQLite design
  simply doesn't have. ADR-000 already scoped D1 out.
- **One DO for everything** — rejected: workspaces are independent
  replication units (ADR-002); per-workspace DOs shard naturally and match
  the socket-per-workspace protocol.
- **Node server as production, CF as backup** — rejected by ADR-000's
  hosting scores; the Node adapter earns its keep as dev/CI parity rather
  than a second production target.

## Consequences

- A hosting switch = implement four small interfaces in a new directory;
  the rank-2 fallback (Railway) would deploy `server-node` nearly as-is.
- DO SQLite's per-object cap (10 GB) and the account cap (5 GB free) dwarf
  demo scale; unbounded op-log growth is documented as compaction-deferred
  (ADR-002).
- The Windows workerd risk (approved plan, risk 5) stays contained:
  wrangler is a verification pass, never the dev loop.
