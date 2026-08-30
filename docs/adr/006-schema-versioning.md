# ADR-006 — Schema version negotiation and pending-write migration

- Status: Accepted
- Date: 2026-08-29
- Deciders: Suvra Samajder

## Context

The constraint: no acknowledged write may ever be silently lost — *including
across schema migrations*. The mandated test (stage 12): a stale client
with pending offline writes upgrades and replays with zero loss. Research
shows every surveyed system punting here (Zero forbids offline writes;
Replicache says "keep old mutators callable"; PowerSync says "stay
backwards-compatible"; Linear's story is unknown).

## Decision

**A single integer `schemaVersion`** owned by the app schema package
(`syncline-demo-schema` for the demo), covering tables, fields, and the
permission ruleset together — one version, one migration chain.

**Negotiation** (ADR-002 frames): `hello` carries the client's version;
`helloAck` returns `{serverSchemaVersion, minWritableVersion}`. Every
pushed op carries `baseSchemaVersion` — the version its payload speaks.

Server acceptance rule — **no silent coercion**:

- `baseSchemaVersion ∈ [minWritableVersion, serverSchemaVersion]`: accept;
  the server migrates the op payload up to current via the shared migrator
  chain before apply.
- Below `minWritableVersion`: per-op rejection via
  `pushAck {opId, rejected: "version"}` (ADR-002) — never a bare `error`
  frame, so the client knows exactly which ops failed.
- Client newer than server: fatal handshake error `VERSION_TOO_NEW`
  (deploy-order bug).

Two distinct stale situations, deliberately separated (review finding):

- **New code, old store** (the common case — app updated while offline
  data waits): the client *can* migrate; it runs the sequence below before
  pushing anything. Nothing is ever rejected.
- **Old code, live server** (the running bundle itself is below
  `minWritableVersion`): the client *cannot* migrate — it lacks the
  migrators. On the version rejection it emits `upgrade-required`
  (ADR-001 event; docs/ux.md renders it), **holds the outbox untouched**,
  and stops pushing. When updated code next boots, it finds the old store
  + outbox and becomes the first case.

**The migration chain** lives beside the schema, both sides sharing it:

```
migrations[vN -> vN+1] = {
  data(rows)   -> rows      // local base-store upgrade
  op(op)       -> op        // TOTAL function; rewrites payload only —
                            // never drops an op, never touches (clientId, clientOpId)
}
```

**The stale-client sequence** (exactly what stage 12 tests, and what the
pill renders as `◐ upgrading · migrating n queued changes`):

1. Client at v1 with pending outbox reconnects; `helloAck` says server is
   at v2.
2. Before any push: run `data` migrations over the local store, run `op`
   migrators over every outbox entry, in one storage barrier (crash-safe:
   restart re-runs from the barrier; migrators are pure, so re-running
   converges).
3. Bump stored client version; resume the normal protocol — push replays
   the migrated outbox under the same identities; acks and echoes retire
  them normally.

Op migrators being **total** is the invariant-(c) linchpin: a version
bump may transform an op (rename a field, reshape a value, degrade it to a
no-op-equivalent update if the field died) but must map every input op to a
valid op — dropping one is a compile-time-visible impossibility (return
type is `Op`, not `Op | null`), and the harness's migration fault asserts
zero acked-write loss across upgrade replays.

**Epoch interaction** (ADR-003/004): a schema bump that changes the
ruleset narrows-or-widens visibility → affected epochs bump, clients take
the snapshot path after migrating. Forget still precedes everything for
revoked principals.

## Options considered

- **Keep old op versions applicable forever server-side** (Replicache's
  "old mutators callable") — rejected: the server accepting a window
  `[minWritable, current]` plus client-side migration bounds the server's
  compatibility surface while still never losing writes; an unbounded
  window rots.
- **Per-table versions** — rejected: ops and rules cross tables; one
  chain, one ordering, one test surface.
- **Reject stale pushes outright, force user re-entry** — forbidden: that
  is silent (to the engine) loss of acknowledged-to-the-user local writes.

## Consequences

- The demo ships at least two schema versions so the upgrade path runs
  live (stage 12 introduces v2: e.g. `priority` string → enum + new field),
  and the harness's version-skew fault keeps exercising it.
- `minWritableVersion` gives the server an explicit deprecation lever with
  a documented failure mode ("upgrade required" UI state) instead of an
  implicit one.
- Cost: every schema change writes two migrators and their tests. That is
  the price of the guarantee, paid where it's visible.
