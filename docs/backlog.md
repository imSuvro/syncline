# syncline — execution backlog (stages 7–17)

Dependency-ordered. `[CF]` marks hosting-gated items (Cloudflare-specific;
everything else runs on the Node adapter or in-process). DoD is the merge
gate for the item's PR. ADR references are normative.

## Epic A — Repo + CI (stage 7)

| ID | Item | Depends on | DoD |
|----|------|-----------|-----|
| A1 | Scaffold 8 workspaces (protocol, client, server, harness, server-node, demo-schema, apps/server-cf, apps/demo) with placeholder exports; pnpm-workspace, tsconfig.base (strict, NodeNext, composite refs), root scripts; delete `spike/` | — | `pnpm build` + `pnpm typecheck` green locally |
| A2 | ESLint flat config + determinism ban scoped to protocol/src, client/src/core, server/src, harness/src (cli carve-out) | A1 | `pnpm lint` green; ban proven by a scratch violation |
| A3 | Root vitest config aliasing packages to src; smoke tests per package | A1 | `pnpm test` green |
| A4 | CI: lint / typecheck / test / pack (attw esm-only on protocol+client) on all PRs + main | A1–A3 | four green checks on the stage-7 PR |
| A5 | `gh repo create imSuvro/syncline --public`, push main + tags, branch protection (4 required contexts, no reviews, no force-push, not enforced for admins) | A4 | `gh api` shows protection; PR-gated merges from here on |

## Epic B — Protocol package + server foundation (stage 8)

| ID | Item | Depends on | DoD |
|----|------|-----------|-----|
| B1 | `@syncline/protocol` wire types + frame codecs/validators per ADR-002 (incl. error-code enum, pushAck result union) | A1 | unit tests: round-trip + malformed-frame rejection |
| B2 | Ruleset types, `evaluate`, `canWrite`, `validateRuleset` (write⟹read rule) per ADR-003 | B1 | unit tests: role matrix, field masks, self predicate, invalid-ruleset rejection |
| B3 | `mergeField` + row/tombstone merge helpers per ADR-005 | B1 | unit tests: stamp comparisons, delete-wins, idempotent re-apply |
| B4 | `syncline-demo-schema` v1: tables (issues, memberships), demo ruleset, seed data | B2 | typechecks; ruleset passes validateRuleset |
| B5 | Server adapter interface (`adapter.ts`: ServerStorage, ConnectionHost, AlarmHost, DirectoryPort, Env) + in-memory fake | A1 | fake passes a storage-contract test suite |
| B6 | WorkspaceCore skeleton: connect/hello/helloAck, JWT-verified principal handoff, membership model, append-only op log + seq, client marks, epochs (ADR-001/002/007) | B1, B2, B5 | unit tests vs fake: hello paths (incremental/snapshot/AUTH_FAILED), append assigns gapless seq |
| B7 | ADR-008 (auth: JWT HS256 claims/expiry/verification at edges) | — | ADR accepted |
| B8 | `syncline-server-node`: node:sqlite storage impl + ws host + JWT edge; boots and answers hello | B6 | manual smoke: wscat hello → helloAck |
| B9 | [CF] `apps/server-cf` skeleton: Worker router, WorkspaceDO + DirectoryDO shells, wrangler.jsonc; compiles under workers types (no deploy) | B6 | `pnpm typecheck` incl. server-cf |

## Epic C — Sync server (stage 9)

| ID | Item | Depends on | DoD |
|----|------|-----------|-----|
| C1 | Push: dedup marks, OP_GAP, canWrite rejection, pushAck results (seq/rejected/duplicate), batched append (ADR-002/003) | B6 | unit: duplicate replay, gap error, forbidden op, mark advance over rejections |
| C2 | Pull: incremental ops frames with advanceTo, snapshot path (permitted live rows, per-field seqs, strictly-greater rule) | C1 | unit: incremental≡snapshot at same seq for fixed epoch |
| C3 | Live delivery: broadcast on append, per-connection permit filtering placeholder (full enforcement E1), own-op echo | C1 | integration via fakes: two connections converge |
| C4 | Presence (full-list on connect/disconnect), ping/pong, error frames | B6 | unit tests |
| C5 | Reconnect + backfill: cursor catch-up, BAD_CURSOR cases; hibernation rehydrate + receive-time epoch check (ADR-004/007) | C2 | harness: kill transport, reconnect, exactly-once to store |
| C6 | Directory propagation: directory_outbox + alarm retry + DirectoryDO upsert; login + /directory endpoints | B8, B9 | integration: membership op reaches directory; duplicate notify idempotent |
| C7 | Harness v1: virtual-time scheduler, seeded PRNG streams, fake transport (ordered, connect/disconnect), fake client/server storage, in-process world | B5 | double-run determinism test: same seed → identical trace hash |

## Epic D — Client engine (stage 10)

| ID | Item | Depends on | DoD |
|----|------|-----------|-----|
| D1 | Client core: state machine (hello/ack modes, ops apply, base+overlay view, cursor) per ADR-001/005 | B1, B3 | unit tests vs scripted server frames |
| D2 | Durable outbox: per-workspace counters, storageWrite+barrier before send, retirement (ack results + echo), op-rejected event | D1 | harness: crash between barrier and send → replay exactly-once |
| D3 | Reactive queries: in-memory materialized store, subscription notify diffing (view-model contract of docs/ux.md) | D1 | unit: notify fires on relevant change only |
| D4 | Adapters: IdbStorage (barrier semantics), WsTransport (reconnect/backoff/pong timeout), BrowserRuntime (effect executor) | D1 | browser smoke page against server-node |
| D5 | Weeks-offline resume: cursor catch-up, outbox replay, snapshot-mode handling with outbox preservation | D2, C5 | harness: offline 10^6 virtual ms with pending ops → converge |
| D6 | Crash/restart recovery from any barrier boundary | D2 | harness crash fault suite green |

## Epic E — Partial replication + permissions (stage 11, the heart)

| ID | Item | Depends on | DoD |
|----|------|-----------|-----|
| E1 | Every outbound data frame through `permitFor` (branded Permitted type); field masking incl. create payloads; per-connection slices | C3, B2 | grep-test: no send construction outside permit module; masked-field matrix tests |
| E2 | Epoch machinery end-to-end: bump on role change/revoke/re-invite, EPOCH_CHANGED close, snapshot re-entry | C5, E1 | harness: live narrowing → reconnect → masked snapshot, outbox replays |
| E3 | Forget end-to-end: revoke step (tx: append+epoch+marks), pushAck→forget→REVOKED ordering, client purge transaction (rows+outbox+cursor+counter), membership-removed event | E2, D5 | the three mandated integration tests: join mid-history; revoke mid-session; re-invite after revoke |
| E4 | Invariant-(b) wiretap in harness (send-time re-evaluate; data-frame ban past revoke seq) + quiescent zero-residue check | E3, C7 | wiretap catches a deliberately planted bypass |

## Epic F — Conflicts + migration (stage 12)

| ID | Item | Depends on | DoD |
|----|------|-----------|-----|
| F1 | LWW property tests (same-field races under reorder/reconnect; different-field merge) | D5, E1 | seeded property suite green |
| F2 | Schema v2 of demo-schema + migrator chain (data + total op migrators) per ADR-006 | B4 | migrator unit tests; validateRuleset on v2 |
| F3 | Negotiation: hello versions, per-op version rejection, upgrade-required path (old code), migration barrier sequence (new code/old store) | F2, D2 | **the mandated test**: stale client with pending writes upgrades and replays with zero acked-write loss |

## Epic G — Demo app (stage 13)

| ID | Item | Depends on | DoD |
|----|------|-----------|-----|
| G1 | App shell per docs/ux.md + mockups: login-as, sidebar, issue list, inline edits (Vite+React+Tailwind on @syncline/client) | D3, D4 | runs against server-node with seeds |
| G2 | Sync chrome: connection pill (+simulate-offline), pending badge, presence dots, sync ticker, attribution flashes | G1 | all states reachable in a scripted pass |
| G3 | Members panel: invite/revoke with confirm; removal card choreography; re-invite bootstrap; upgrade-required state | G1, E3 | revoke-vanish works in two local browsers |
| G4 | Seeds (2 workspaces, 4 users, ~40 issues), incognito copy-link, demo script on landing | G1 | fresh boot lands the full demo path |

## Epic H — Testing (stage 14)

| ID | Item | Depends on | DoD |
|----|------|-----------|-----|
| H1 | Fault knobs: latency/drop/dup/reorder/partition, connection death, client crash (barrier model), server hibernate, clock skew | C7, D6 | each fault has a targeted regression test |
| H2 | Workload generator: seeded mixed ops incl. mid-sync revoke/invite, offline/online churn, version-skew boots | H1, F3 | scenario JSON round-trips; seeds reproduce |
| H3 | Invariant checkers (a) convergence vs evaluate-filtered server state, (b) wiretap+residue, (c) acked-write survival — wired into the campaign loop | E4, H2 | planted violations of each caught |
| H4 | Repro CLI (`pnpm fuzz --seed N --trace`), failure artifacts, docs/bugs.md | H3 | failing seed replays byte-identically cross-process |
| H5 | CI: fuzz-smoke (~200 seeds, <3 min) as 5th required context; fuzz-nightly (cron, ≥1,000 seeds, artifact upload) | H4 | both workflows green; protection updated |

## Epics I–K — Review, deploy, launch (stages 15–17)

| ID | Item | Depends on | DoD |
|----|------|-----------|-----|
| I1 | Full-codebase review (engineering:code-review); fix or log-with-rationale; cross-browser (Chrome/Firefox/Edge) + mobile-viewport pass | G, H | findings closed; matrix in PROJECT_LOG |
| J1 | [CF] `wrangler deploy` server-cf + `wrangler secret put JWT_SECRET`; smoke via wss:// | B9, I1 | live workers.dev URL answers hello |
| J2 | Vercel prod deploy of apps/demo with prod VITE_SYNC_URL; live two-browser verification (offline-converge; revoke-vanish) | J1 | both verifications pass on live URLs; recorded in PROJECT_LOG |
| K1 | docs/protocol.md (stranger-implementable: frames, identity, cursors/epochs, permission semantics, forget, LWW, migration, limits) | E, F | self-contained read-through against ADRs |
| K2 | docs/writeup.md (design essay vs Replicache/ElectricSQL/PowerSync; LWW anomalies; offline-forget limitation) | K1 | non-stub, cites research.md |
| K3 | Recruiter README: what/why, architecture diagram, live URLs, revoke GIF (browser tooling) | J2 | README renders with working links + GIF |
| K4 | Publish-readiness: attw green, package metadata, versions; npm auth + @syncline org → NEEDS-HUMAN walkthrough | K3 | `npm pack` output verified; NEEDS-HUMAN entry written |

Sequencing notes: B and C7 can interleave; D starts once B1–B3 land; E is
strictly after C+D; G1/G2 UI shell may start during F; K1/K2 draft during
I/J. The only hosting-gated chain is B9 → J1 → J2.
