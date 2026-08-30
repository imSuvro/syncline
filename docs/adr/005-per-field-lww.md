# ADR-005 — Per-field LWW and client reconciliation

- Status: Accepted
- Date: 2026-08-29
- Deciders: Suvra Samajder

## Context

Research shows the server-authoritative family (Linear, PowerSync,
Replicache/Zero) converging on the same conflict answer: last-writer-wins
at field granularity, ordered by the server, no CRDTs for domain data.
syncline adopts it deliberately and spends its complexity budget on
entitlement semantics instead (docs/research.md, gap statement).

## Decision

**Stamp = server `seq`, per field.** Every field of every row carries the
seq of the op that last wrote it: `field: {v, seq}`. The merge rule, in
`@syncline/protocol` as a pure function shared by server apply, client
apply, and harness:

```
mergeField(current: {v, seq} | undefined, incoming: {v, seq})
  -> incoming.seq > (current?.seq ?? 0) ? incoming : current
```

Wall-clock never participates — LWW-by-clock is the classic skewed-client
bug; LWW-by-seq is total, deterministic, and clock-skew-immune.

**Server apply** is trivially monotonic: ops apply in seq order, so every
apply wins. The rule exists for the client, where snapshots, backfill, and
replays can present frames out of arrival order (never out of seq order
within a stream, but merges across snapshot + incremental joins need the
guard).

**Delete tombstones win.** A `delete` op stamps the row
`deleted: {seq}`; field updates with lower seq arriving later (only
possible in cross-path merges) are discarded. Recreating uses a fresh
`rowId` — the demo never reuses ids, dodging resurrection ambiguity
(PowerSync's "deletes always win" with id-recreation is the precedent; the
constraint is documented in docs/protocol.md).

**Client reconciliation — base + overlay:**

- `base`: server-confirmed state, advanced only by `snapshot` and `ops`
  frames (via `mergeField`).
- `outbox`: pending local ops, clientOpId order.
- The rendered view = `base` with outbox ops applied on top (optimistic).

Retirement is two-channel and idempotent (ADR-002): a `pushAck` result —
`{opId, seq}`, `{opId, duplicate}`, or `{opId, rejected}` — removes the
outbox entry (rejection also reverts the overlay and emits `op-rejected`);
the own-op echo in the `ops` stream writes the accepted value into `base`
with its assigned seq. Either channel can arrive first (reconnect races);
both orders converge — the overlay only ever covers fields whose outbox
entries still exist. After a snapshot join, incoming ops are strictly
`> atSeq` (ADR-002), so `mergeField`'s guard is defense in depth there,
not a correctness dependency.

**The visible anomaly, embraced**: two clients editing the *same field*
concurrently — later server order wins, the loser's optimistic value is
replaced when its base updates under a retired overlay, and the UI shows
the attribution flash (`status ▸ Done · Priya, just now`, docs/ux.md).
Different fields of the same row merge losslessly — the scripted demo beat.
Known LWW anomaly classes (lost same-field update; read-modify-write over
stale base) are documented in docs/writeup.md rather than patched; if the
demo domain ever surfaces a demonstrably wrong merge, the schema is
constrained (per the brief) — never a silent switch to CRDTs.

## Options considered

- **LWW by client wall-clock (HLC-less)** — rejected: skewed clients
  reorder causally-later writes; every serious system avoids it.
- **Hybrid logical clocks** — rejected: buys ordering across servers
  syncline doesn't have (single per-workspace authority already yields a
  total order for free).
- **CRDTs for domain data** — deferred by PRD; Automerge's full-history
  model is also structurally hostile to forget (docs/research.md).
- **Row-granular LWW** — rejected: loses the "two people edit title and
  status concurrently" merge, which is the common collaborative case and
  the demo's proof moment.

## Consequences

- Convergence proofs reduce to seq comparisons; invariant (a) is
  `deepEqual(clientBase, evaluate-filtered serverState)` at quiescence.
- One-field-per-op (ADR-002) is what makes the stamp granularity natural.
- Text fields get whole-value LWW — honest limitation, listed under PRD
  deferrals (CRDT text).
