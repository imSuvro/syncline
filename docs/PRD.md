# syncline — product requirements

## One-liner

A local-first sync engine, shipped as npm packages, whose differentiating
feature is **permission-aware partial replication enforced in the sync
protocol itself** — including an active, specified "forget" pushed to clients
when their permission is revoked — proven by a team issue tracker demo where
you can watch a revoked member's local data vanish from their browser.

## Why (from docs/research.md)

The 2026 sync-engine landscape splits the problem: engines document protocols
but keep permissions outside them (ElectricSQL), enforce entitlements in the
sync service but leave revocation half-solved and the wire format
under-specified (PowerSync), actively forget on revocation but document none
of it (Linear, known only via endorsed reverse engineering), or reject the
problem's premises (Zero: no offline writes; Automerge: no permissions, no
forgetting, by construction). Nobody delivers, together: sync-layer
permission enforcement, specified active forget, and a
stranger-implementable protocol document. syncline is that combination.

## Audiences

1. **Engineers evaluating the author** — the demo, the protocol doc, and the
   test harness are the portfolio.
2. **Developers who could adopt the packages** — `@syncline/protocol` (wire
   types + permission evaluator + LWW merge, zero IO) and `@syncline/client`
   (IndexedDB store, outbox, reactive queries) must be usable and honest
   about limits.

## In scope (the engine)

| Capability | Definition of done |
|---|---|
| Client-side local store | IndexedDB-backed durable store; reactive queries; reads/writes work fully offline |
| Durable outbox | Every local mutation persists before send; survives crash/restart; replays exactly-once to the server (idempotent push by client op id) |
| Push/pull protocol | Server-assigned total order per workspace (`seq`); per-subscription cursors; WebSocket delivery with reconnect + backfill; documented in docs/protocol.md |
| Partial replication | A client receives exactly its subscribed, permitted slice — never whole tables |
| Permission enforcement in the sync layer | Every outbound op passes the shared permission evaluator inside the sync path; request-handler-only checks are defined as bugs |
| Revocation-forget | Revoking membership pushes an explicit, idempotent `forget` instruction to live clients and forces it at next handshake for offline ones; client transactionally purges store + outbox and surfaces "you were removed" |
| Per-field LWW conflicts | Field-granular last-writer-wins keyed on server order (never wall clock); one merge implementation shared by server and client |
| Schema versioning | Handshake version negotiation; a stale client with pending writes upgrades (data + outbox migrators) and replays with zero loss — tested as exactly that scenario |

Invariants the stage-14 harness enforces across randomized interleavings:
(a) all permitted clients converge to identical state; (b) no client ever
holds data it lacks permission for (checked at send time and at quiescence);
(c) no acknowledged write is ever lost, including across crash and schema
migration.

## Deferred (stated, not hidden)

- **CRDT text / rich collaborative editing** — per-field LWW is the chosen
  tradeoff; research shows the server-authoritative family (Linear,
  PowerSync, Replicache/Zero) wins for multi-tenant tools, and the complexity
  budget goes to entitlement semantics instead. Known LWW anomaly classes get
  documented in docs/writeup.md, not silently patched.
- **P2P sync** — server authority is load-bearing for permissions and order.
- **End-to-end encryption** — orthogonal to the thesis; Keyhive-style
  approaches also show it cannot retract already-shared plaintext.
- **Offline-device forget guarantee** — a device that never reconnects can
  never be made to forget; no system solves this and syncline says so in the
  protocol doc rather than pretending.
- Log compaction (the snapshot path is the documented escape hatch),
  cross-workspace ordering, presence beyond the demo's needs.

## The demo app (proof, not product)

A team issue tracker (`apps/demo`, Vite + React, deployed on Vercel) built
entirely on `@syncline/client`:

- **Workspaces** are the replication + permission unit; issues belong to
  workspaces.
- **Roles**: owner (manage members + edit), editor (edit issues), viewer
  (read only). Role changes and revocation take effect through the sync
  layer, not UI hiding.
- **Invite / revoke** from a member panel; revocation is the showcase:
  revoke a member in browser A and watch their local data vanish in
  browser B without a reload.
- **Sync made visible**: offline banner, pending-ops badge, per-user
  presence dots, "syncing…" states.
- **No signup wall**: pre-seeded demo accounts behind a login-as picker;
  a one-click "open second user in incognito" path for the two-browser demo.
- Seed data: 2 workspaces, 4 users, ~40 issues — enough to make partial
  replication legible (different users see different slices).

## Success criteria

1. **The revoke moment**: two browsers on the live URLs; owner revokes a
   member; the revoked browser's workspace data visibly disappears within
   seconds, and its store + outbox are verifiably empty of that workspace.
2. **Offline convergence**: edit offline in both browsers, reconnect, both
   converge to the identical merged state with zero lost acknowledged writes.
3. **Harness green**: ≥1,000 randomized seeds (nightly tier) upholding
   invariants (a)(b)(c); any failing seed reproduces byte-identically.
4. **Stranger test**: docs/protocol.md is complete enough to implement a
   client without reading syncline source.

## Constraints

- $0 hosting (per docs/adr/000-hosting.md: Cloudflare Workers + DO SQLite
  default; Vercel for the demo frontend), no card, no new accounts.
- All platform-specific server code behind one adapter interface
  (`packages/server/src/adapter.ts`); a hosting switch touches one directory.
- Determinism-first: business logic never touches clock/RNG/IO directly —
  the stage-14 harness depends on it.
- No acknowledged write may ever be silently lost. Gap detection fails loud.
