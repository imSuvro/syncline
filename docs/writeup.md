# Permission-aware partial sync, and what it costs

A design essay about syncline: what it does that the field doesn't, what it
gives up to do it, and where it is honestly weaker than the alternatives.

## The gap

I surveyed six sync engines before writing any code (`research.md`), holding
one question constant: **what happens to a client's local data when its
permission is revoked?**

The answers were more uniform than I expected:

- **Replicache** removes newly-unauthorized rows as `del` operations on the
  client's *next pull*. The mechanism is real and correct, but it is passive,
  and the docs never discuss revocation as a scenario — there is no stated
  guarantee to rely on.
- **Zero** doesn't say. Neither its current permission docs nor the deprecated
  RLS generation states whether already-synced rows leave a client that loses
  access. Data-encoded revocation *should* retract rows through incremental
  query maintenance, but that's my inference, not a promise.
- **ElectricSQL** enforces nothing itself by design — auth lives in a proxy in
  front of it. Token revocation fails the *next request*; the synced data
  stays on the device, and the documented remedy is "on logout, perform a full
  page refresh."
- **PowerSync** is the closest prior art and the one I learned most from:
  entitlements are computed *inside* the sync service from verified JWT
  claims, and a membership change propagates as `removed_buckets` in a
  checkpoint diff that connected clients apply by deleting local data. But JWT
  revocation itself is unsolved (the advice is 5-minute expiry), and an
  offline device is never purged.
- **Linear** actually does the thing — sync-group removal is pushed over the
  live socket and the client deletes the affected models. It is the only
  active-forget precedent I found, and it is documented nowhere official; we
  know it because someone reverse-engineered it and Linear's CTO confirmed the
  writeup was correct.
- **Automerge** structurally cannot. Every peer holds full history; there is no
  permission layer, and `sharePolicy` is gossip control, not access control.
  Ink & Switch's Keyhive answers with key rotation — which protects future
  changes and explicitly cannot un-share plaintext already replicated.

So: the only system that pushes an active forget doesn't document it, the only
system that evaluates permissions in the sync layer leaves offline devices
untouched, and the system with the best wire documentation deliberately has no
permissions in the protocol at all. Nobody delivers all three together.

syncline is that combination, and nothing more ambitious: permissions
evaluated in the sync path on every outbound op, an explicit acknowledged
`forget` message, and a protocol document a stranger could implement from.

## What "in the sync layer" actually buys

The phrase is easy to say and easy to fake. The test I held myself to: *can a
bug in a request handler leak data?* If authorization lives in handlers, then
every new code path is a new place to forget the check, and the checks drift.

In syncline the answer is structural. The arrays that become `snapshot.rows`
and `ops.ops` are typed `Permitted<RowState>[]` and `Permitted<LogEntry>[]`,
and the only module that can produce that brand is the one that calls the
evaluator. An unfiltered row reaching a client is a compile error, not a code
review question. Three source-level guards assert the brand has exactly one
minting site, and the fuzz harness independently re-derives the answer at send
time — re-reading the live membership and re-running the evaluator on every
outbound frame, so a leak is caught even when the server believes it filtered
correctly.

That last part mattered more than I expected. The wiretap is deliberately not
the same code path as the server's own filtering, because a checker that
shares the bug it's checking for proves nothing.

## What it cost

**Per-field LWW, chosen on purpose.** syncline resolves conflicts by
last-writer-wins at field granularity, ordered by a server-assigned sequence
number. This is strictly weaker than a CRDT for text, and I want to be precise
about the anomaly rather than bury it:

> Two users edit the same field of the same issue concurrently. Both see their
> own value immediately. One of them, on the next round trip, watches their
> edit replaced by the other's. Nothing warns them beforehand; the only signal
> is the change itself.

That is a real, reachable, user-visible defect. Per-field granularity narrows
it — the common collaborative case, two people editing *different* fields of
one row, merges losslessly, which is why the demo scripts that beat — but it
does not eliminate it. For a title field, LWW is defensible. For a
paragraph-length description, it is not, and syncline's honest answer is
"model that field differently or don't use this engine for it," not a silent
CRDT swap.

The reason for accepting that cost is the thesis. CRDTs and revocation pull in
opposite directions: a CRDT's correctness comes from every replica retaining
enough history to merge with any other, and forgetting is precisely what
syncline needs a client to do on command. Automerge's own trajectory is the
evidence — the answer to permissions there is encryption, and encryption
cannot retract. The complexity budget went into entitlement semantics instead
of merge semantics, because for multi-tenant collaborative tools, *who is
allowed to hold this data* is both the harder problem and the less-served one.

**The offline device.** A device that never reconnects never forgets. I could
have hidden this behind a short token expiry and called revocation solved,
which is roughly what the field does. Instead the protocol states the exact
guarantee — forget is enforced at the first moment of contact after
revocation, and no post-revocation data ever reaches the revoked principal —
and names what it does not cover. A system that overstates its security
properties is worse than one that understates them.

**No log compaction.** The full op log is retained, so any cursor can be
answered. At demo scale that's free; at real scale the snapshot path (which
re-invite already requires) is the compaction escape hatch, and I documented
it as such rather than pretending the design scales unmodified.

**Row-scoped read predicates.** The rule language can express `self`-style row
visibility, and live broadcast handles it correctly, but historical backfill
judges past ops against present row state. The review caught this; rather than
patch it blindly I scoped it out of v1 and wrote the limitation down. The
shipped ruleset doesn't use those predicates, so nothing is broken — but the
engine claims less than its type signatures suggest, and saying so is cheaper
than a subtle leak later.

## What the testing actually found

The centerpiece of the test strategy is a randomized interleaving campaign: N
clients on virtual time with seeded RNG, going offline and back, editing
concurrently, being revoked and re-invited mid-sync, with duplicate frame
delivery — asserting on every run that permitted clients converge, that no
client holds data it isn't entitled to, and that no acknowledged write is
lost. A thousand seeds run in twenty-two seconds, and any failure reproduces
exactly from its seed.

It earned its keep on the first real run. Seeds 66 and 377 failed convergence,
and the cause was a genuine engine bug: a frame still in flight from a
previous socket rewound the client's cursor, stranding every operation between
the stale mark and where the client actually was. Silent, permanent
divergence — the exact failure mode the whole design exists to prevent, and
not something I would have found by writing more unit tests, because I'd have
written them against the same mental model that produced the bug.

The broader pattern is in `bugs.md`: eight defects, and the interesting thing
is *which layer caught which*. Unit tests caught the algebra (a re-invite that
its own tombstone rule made impossible). The determinism test caught a
falsified network model — my fake transport reordered frames within a
connection, which WebSockets never do, so it was reporting a convergence
failure that was the harness's fault. Driving the actual browser caught three
bugs no test reached: a React memo that froze the pending-ops badge, a storage
rejection that could silently freeze the engine forever, and racing storage
batches. And an adversarial review caught six more, four of them security
issues invisible to any test that only exercises the happy path — most
seriously, that a client id was never bound to its authenticated user, so any
member could claim another's device id and destroy their pending writes.

No single technique found more than a third of them. That's the argument for
using all of them, and the reason the fuzz tier is a required CI check rather
than a nightly nicety.

## What I'd revisit

**Reactive queries recompute from scratch.** `queryTable` materializes base
plus overlay on every call. At demo scale (hundreds of rows) this is free and
the code is obvious. At tens of thousands it becomes the bottleneck, and the
fix is incremental view maintenance keyed on the fields each query touches. I
measured nothing here because there was nothing to measure at this scale, and
guessing at a performance problem is how you get the wrong abstraction.

**Workspace-granular forget.** The `forget` message carries an epoch and a
sequence bound, but the scope is always "the whole workspace." Row-set and
field-mask scopes are the obvious extension, and the message shape already has
room for them. I stopped at the granularity the demo could actually
demonstrate, because a feature nobody can watch work is a feature nobody can
verify.

**One socket per workspace.** This matches the Durable Object topology exactly
and keeps ordering trivially per-workspace. A user in fifty workspaces would
hold fifty sockets, which is wrong — but multiplexing means a fan-in router in
front of the per-workspace authorities, and that's a different system. I'd
rather have the simple thing with a documented ceiling than the general thing
with an undocumented one.
