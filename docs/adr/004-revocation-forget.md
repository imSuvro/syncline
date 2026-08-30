# ADR-004 — Revocation and the forget mechanism

- Status: Accepted
- Date: 2026-08-29
- Deciders: Suvra Samajder

## Context

The centerpiece. Research (docs/research.md) shows the field's state: the
only active-removal precedent (Linear's sync-group removal) is documented
nowhere officially; PowerSync removes at next checkpoint but never purges
offline devices; everyone else is passive, silent, or structurally unable.
syncline promotes forget to a first-class, specified, tested protocol
message.

## Decision

**Forget is an explicit per-principal instruction, distinct from delete
tombstones.** Deletes are *data* — every permitted client learns them.
Forgets are *instructions to a specific principal's devices* — "you are no
longer entitled to hold this; erase it."

```
forget {epoch, upToSeq}          // scope: the whole workspace (v1)
```

**Server side.** A revoke is an ordinary `delete` op on the `memberships`
table (ADR-002), owner-authorized (ADR-003). When the server applies it, in
the same step:

1. Append the op, assign `seq` (this becomes the forget's `upToSeq`).
2. Bump the revoked principal's **epoch** for this workspace, persist it,
   and **clear the principal's client dedup marks** (all its clientIds in
   this workspace) — paired with the client-side counter reset below, this
   is what keeps ADR-002's gap rule sound across re-invite.
3. For every live connection of the revoked principal: if the revoke came
   in over that very connection (self-removal), send its `pushAck` first;
   then send `forget {epoch, upToSeq}`, then `close` with code `REVOKED`.
4. Broadcast the membership delete as a normal op to remaining members
   (their member lists update; no forget for them — it's data to them).

Steps 1–2 run inside one storage transaction (ADR-007 `tx`); sends follow.
A crash between commit and send is safe: the persisted epoch makes every
later contact re-derive the forget.

**Offline devices.** At the next `hello`, the server compares the client's
cursor epoch with the stored epoch. Revoked → the server sends `forget`,
then `error {code: REVOKED}` and closes — no `helloAck`, no data. The
device forgets at reconnect, however late.

**Hibernation-surviving connections.** A Durable Object can restart while
its WebSockets stay open (ADR-007) — no new `hello` ever arrives. Rule: on
**every** message received, the server compares the connection's
epoch-at-hello (a non-authoritative attachment field) with the stored
epoch; on mismatch it answers with `forget` + `REVOKED` close (revoked) or
an `EPOCH_CHANGED` close (slice changed). The permit path never reads the
attachment (ADR-003); this check exists only to evict stale connections.

**Live narrowing** (role change that shrinks visibility, no revocation):
epoch bump + close `EPOCH_CHANGED` on that principal's connections; the
forced re-`hello` takes the snapshot path (ADR-002). No forget — local
state is replaced by the masked snapshot, and pending outbox ops replay
(newly forbidden ones come back `rejected`).

**Client side.** On `forget`, transactionally (one storage barrier): delete
every local row of the workspace, drop every outbox op targeting it, reset
the cursor, **reset the workspace's `clientOpId` counter** (the server
cleared its marks in the same revoke step), then emit the
`membership-removed` event (UX: the removal card, docs/ux.md). Forget is
**idempotent and replayable** — applying it twice or after a crash-restart
mid-purge converges to the same empty state (the harness asserts this under
crash faults).

**Re-invite** creates a fresh epoch; the client bootstraps via the snapshot
path (ADR-002). Never resurrection: pre-revoke local state is gone, and any
pre-revoke outbox ops were dropped — a revoked member's unsent edits do not
apply retroactively (documented, deliberate: entitlement ended before the
server ordered them).

Forget is reserved for losing the workspace entirely, keeping its
semantics stark and auditable; narrowing is handled by the live-narrowing
rule above.

**The honest limitation, stated in docs/protocol.md**: a device that never
reconnects can never be made to forget — the instruction cannot reach it.
No surveyed system solves this (key-rotation schemes protect only future
data). syncline's guarantee is exact: *forget is enforced at the first
moment of contact after revocation, and no post-revocation data ever
reaches the revoked principal* (invariant b covers the second half at every
send).

## Options considered

- **Server tombstone push of every affected row** — rejected: O(rows)
  messages to say one thing; conflates data-deletes with entitlement (a
  remaining member would be unable to distinguish "issue deleted" from
  "you can't see it"); and row-enumeration adds nothing since the revoked
  client already holds the rows.
- **Subscription recompute on next pull only** (Replicache row-version
  style) — rejected: passive removal fails the thesis; a live revoked
  client would keep its replica until it happens to pull.
- **Epoch-only, snapshot-of-empty** — considered (a revoked client's
  permitted slice is empty, so the snapshot path alone would clear it) but
  rejected as the primary mechanism: an explicit forget is auditable,
  testable, documentable, and carries the intent ("purge, including your
  outbox") that an empty snapshot does not — an empty snapshot must not
  imply dropping unsent local writes, but revocation must.

## Consequences

- Invariant (b) becomes checkable at two levels: no **data frame**
  (`snapshot`/`ops`) and no op payload to a revoked principal after the
  revoke op's seq — `pushAck`, `forget`, and the close are the only frames
  allowed past it (send-time wiretap) — and zero residue at quiescence
  (store + outbox scan).
- The revoke path is the demo's money shot, and its protocol frames are
  visible in the UI ticker — the feature demonstrates itself.
- Workspace-granular scope keeps v1 stark; `scope` is the extension seam if
  row-set or field-mask forgets are ever needed.
