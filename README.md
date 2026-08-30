# syncline

A local-first sync engine whose distinguishing feature is the thing most sync
engines leave undocumented: **when you revoke someone's access, their device
is told to forget the data — and does.**

**[Live demo](https://syncline-suvros-projects.vercel.app)** ·
sync server at `syncline-server.weekendbuild.workers.dev` ·
[protocol spec](docs/protocol.md) · [design essay](docs/writeup.md)

No signup. Pick a persona and start.

## Watch the thing it's for

Open the demo twice — once normally, once in an incognito window (the landing
page copies the link for you). Sign in as **Priya** in one and **Maya** in the
other, both in Acme Launch.

1. **Edit different fields of one issue in both windows.** They merge. Per-field
   last-writer-wins, keyed on server order, so a title change and a status
   change to the same row never clobber each other.
2. **Hit "simulate offline" in Maya's window and keep editing.** The pill
   reads `offline · n saved locally`; edits queue in a durable outbox. Go back
   online and watch the ticker push them, get sequence numbers, and land in
   Priya's window.
3. **As Priya, revoke Maya.** In Maya's window the ticker prints
   `▼ forget workspace=acme`, every issue disappears, and a card explains that
   the device has forgotten the workspace. Her IndexedDB for that workspace is
   left holding one metadata key — zero rows, zero queued writes.

That third step is the whole project. Everything else exists to make it
trustworthy.

## Why it's interesting

I surveyed six engines first — Replicache, Zero, Linear, ElectricSQL,
PowerSync, Automerge (see [research.md](docs/research.md)) — asking one
question: *what happens to local data on revocation?* The field's answers:
passive removal on next pull, undocumented, "refresh the page," offline
devices never purged, or structurally impossible. The one system that pushes
an active forget documents it nowhere.

syncline does three things together that no surveyed system does:

**Permissions live in the sync layer, not in request handlers.** Every
outbound operation passes a shared evaluator against a role read live from the
membership row — never from the token. This is enforced by the type system:
the arrays that become wire frames are branded `Permitted<T>`, and only the
module that calls the evaluator can produce that brand, so an unfiltered row
reaching a client is a compile error.

**Forget is a real protocol message.** Revocation atomically bumps the
principal's epoch, clears their write-dedup marks, pushes `forget` to live
devices, and closes their sockets. An offline device gets the forget before
any data on its next handshake. The client applies it in one durable
transaction: rows, queued writes, cursor, and op counter, all gone.

**The protocol is documented well enough to reimplement.**
[docs/protocol.md](docs/protocol.md) specifies frames, identity, cursor and
epoch semantics, permission evaluation, forget, conflict resolution, and
schema migration — including what is deliberately *not* supported.

## Architecture

```
@syncline/protocol   wire frames + codecs · permission evaluator · LWW merge
                     pure functions, zero IO, zero dependencies
        │
        ├── @syncline/client    sans-IO engine (durable outbox, optimistic
        │                       overlay, cursor catch-up, forget) + IndexedDB
        │                       and WebSocket adapters
        │
        ├── @syncline/server    deterministic WorkspaceCore behind ONE adapter
        │                       interface — no platform code anywhere in it
        │       ├── server-node      node:sqlite + ws   (local dev, CI parity)
        │       └── apps/server-cf   Cloudflare Worker + SQLite Durable Objects
        │                            with WebSocket hibernation  ← production
        │
        └── syncline-harness    virtual time · seeded PRNG · fake transport
                                with fault injection · invariant checkers
```

Both cores are sans-IO: they consume explicit inputs and return ordered
effects, touching no clock, no randomness, and no socket. That is what makes
the whole system replayable, and it's enforced by a lint rule that bans
ambient time and IO in those packages.

## Correctness

A randomized interleaving campaign runs N clients through offline churn,
concurrent edits, mid-sync revocation and re-invitation, and duplicate frame
delivery, asserting three invariants continuously:

- **(a)** every permitted client converges to its own permitted slice
- **(b)** no client ever holds data it lacks permission for — checked by an
  independent wiretap that re-evaluates every outbound frame, plus a residue
  scan after revocation
- **(c)** no acknowledged write is ever lost, including across crashes and
  schema migrations

**1,000 seeds run in 22 seconds**, and any failure reproduces exactly:

```bash
pnpm fuzz --seed 66
```

That seed is not hypothetical — it caught a real cursor-rewind bug that caused
silent permanent divergence. Every CI run gates on 300 seeds; nightly runs
5,000 across three fault profiles. [docs/bugs.md](docs/bugs.md) lists all
eight defects the verification stack found and which layer caught each.

## Run it locally

```bash
pnpm install && pnpm build
```

```bash
pnpm dev:server
```

```bash
pnpm --filter syncline-demo dev
```

The demo talks to `http://localhost:8787` in development and to the deployed
Worker in production builds.

```bash
pnpm test && pnpm fuzz
```

## Documentation

| Document | What's in it |
|---|---|
| [protocol.md](docs/protocol.md) | The wire protocol, complete enough to implement a client |
| [writeup.md](docs/writeup.md) | Design essay: the tradeoffs against Replicache/ElectricSQL/PowerSync, and what LWW costs |
| [research.md](docs/research.md) | The six-engine survey the design came from |
| [PRD.md](docs/PRD.md) · [ux.md](docs/ux.md) | Scope and the demo's interaction design |
| [adr/](docs/adr/) | Nine decision records, ratified after an adversarial consistency review |
| [bugs.md](docs/bugs.md) | Every bug the tests, the fuzzer, and the review found |
| [PROJECT_LOG.md](PROJECT_LOG.md) | Stage-by-stage build log |

## Deliberate limitations

No CRDT text (per-field LWW instead — the anomaly is documented, not hidden),
no P2P, no end-to-end encryption, no log compaction, and no way to force a
device that never reconnects to forget. That last one is unsolved everywhere;
syncline states its guarantee precisely rather than implying more.

MIT licensed.
