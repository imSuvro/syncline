# syncline — project log

Local-first sync engine with permission-aware partial replication, shipped as
npm packages (`@syncline/protocol`, `@syncline/client`) plus a team issue
tracker demo that makes partial sync and permission revocation visible: revoke
a member in one browser and their local data vanishes in the other.

## Stage status

| # | Stage | Role | Status | Tag |
|----|-------|------|--------|-----|
| 1 | Research | Product Owner | done | v0.1 |
| 1b | Hosting research | Architect | done | v0.2 |
| 2 | Product definition (PRD) | Product Owner | done | v0.3 |
| 3 | Feasibility spike | Architect | done | v0.4 |
| 4 | UX | UX Designer | done | v0.5 |
| 5 | Architecture (ADRs) | Architect | done | v0.6 |
| 6 | Planning (backlog) | Product Owner | done | v0.7 |
| 7 | Repo + CI | DevOps | done | v0.8 |
| 8 | Server foundation | Dev | done | v0.9 |
| 9 | Sync server | Dev | done | v0.10 |
| 10 | Client engine | Dev | done | v0.11 |
| 11 | Partial replication + permissions | Dev | done | v0.12 |
| 12 | Conflicts + migration | Dev | done | v0.13 |
| 13 | Demo app | Dev | done | v0.14 |
| 14 | Testing | QA | pending | |
| 15 | Review | QA/Dev | pending | |
| 16 | Deploy | DevOps | pending | |
| 17 | Launch | Product Owner | pending | |

Tag mapping (1b gets its own tag): stage 1→v0.1, 1b→v0.2, 2→v0.3, 3→v0.4,
4→v0.5, 5→v0.6, 6→v0.7, 7→v0.8, 8→v0.9, 9→v0.10, 10→v0.11, 11→v0.12,
12→v0.13, 13→v0.14, 14→v0.15, 15→v0.16, 16→v0.17, 17→v0.18.

## Decisions

- **2026-08-29** Name/location: `imSuvro/syncline` at `D:\Personal\syncline`;
  npm scope `@syncline` (`@syncline/protocol`, `@syncline/client`); demo on
  Vercel; sync server platform per the stage-1b ADR. Name availability
  verified at decision time: npm bare name `syncline` unregistered, scope
  `@syncline` has zero packages, `imSuvro/syncline` free on GitHub, no
  prominent OSS collision (best exact-name match ≤7 stars). Runner-up
  "sightline" rejected: npm name squatted since 2015, a 561-star active TS
  project owns the name, several established software companies brand with it.
  Fallback if the `@syncline` npm org proves taken at login time:
  `@syncline-dev/*` (recorded with the npm-auth NEEDS-HUMAN entry at launch).
- **2026-08-29** Conventional commits, no AI-attribution trailers (mirrors the
  author's established convention).
- **2026-08-29** Toolchain mirrors the author's proven raftlab setup: pnpm
  workspaces, strict TS project references + `tsc -b` typecheck, ESM-only
  library builds via plain `tsc`, Vitest, ESLint flat config with a
  determinism lint ban (no `Date.now`/`Math.random`/timers/`node:` imports)
  scoped to the deterministic packages, `attw --pack` publish checks in CI.
- **2026-08-29** Determinism-first architecture: all nondeterminism and IO in
  client/server business logic is injected (clock, RNG, ids, storage,
  transport, scheduling) from day one, because the stage-14 seeded
  interleaving harness is only possible if stages 8–12 are built on those
  interfaces. Server storage port is synchronous (both Durable Object SQLite
  and `node:sqlite` are synchronous), so cores never await mid-decision.
- **2026-08-29** Deploys run from the working session (authenticated Vercel
  CLI/connector, wrangler); CI never deploys (no tokens as repo secrets).
- **2026-08-29** Stages 1–6 merge to main locally (predate the remote); from
  stage 7 on, stage branches merge through pull requests gated by the required
  CI contexts (lint/typecheck/test/pack, + fuzz-smoke from stage 14). Branch
  protection: required contexts, no required reviews (solo), force-push
  disabled, not enforced for admins as the emergency hatch.

## Stage notes

- **Stage 1 (research).** Six systems surveyed with all claims traced to
  sources fetched 2026-08-29 (docs/research.md). Headline findings: no
  surveyed system documents revocation; the only active-forget precedent is
  Linear's sync-group removal, known solely via CTO-endorsed reverse
  engineering; PowerSync is the only system evaluating permissions inside the
  sync service (JWT-derived buckets, `removed_buckets` checkpoint diffs) but
  leaves offline devices and token revocation unsolved; ElectricSQL has the
  best wire docs but zero authorization in the protocol by design; Zero
  rejects offline writes entirely; Automerge structurally cannot forget
  (full-history CRDT). Gap statement: permissions in the sync layer + a
  specified, acknowledged forget message + a stranger-implementable protocol
  doc covering the full loop — no surveyed system delivers any two of the
  three together.

- **Stage 3 (spike numbers).** `spike/spike.mjs` (throwaway, deleted at
  stage 7): 2 simulated clients, in-memory server with append-only op log +
  server-assigned seq, per-field LWW by seq, seeded random interleaving with
  connectivity drops, offline outbox replay, idempotent push by
  (clientId, clientOpId) with gap detection. Results on the dev machine
  (Node 22.22): 10k mutations + 5.4k sync rounds converge in ~32 ms
  (~307k mutations/sec through the whole loop); duplicate-push replay of an
  acked batch is a verified no-op; same seed twice → byte-identical state
  fingerprint (determinism holds with zero effort at this scale, validating
  the injected-PRNG design). At 100k mutations the naive spike drops to
  ~46k mutations/sec because its pull is a full-log filter (O(n) per sync) —
  an artifact of spike laziness; the real server pulls by indexed cursor.
  Optimistic view = base + outbox replay via `structuredClone` was
  negligible at 50 rows × 4 fields; the real client materializes
  incrementally anyway. Feasibility confirmed; no scale surprises.

- **Stage 4 (UX).** Direction: "instrument panel" — calm paper-toned tracker
  UI, with everything the engine says (connection pill, pending counts, seq
  numbers, forget instructions) rendered as monospace telemetry; signature
  element is the sync ticker narrating the live op stream, so the revoke
  showcase is visibly announced on the wire one beat before rows dissolve.
  docs/ux.md pins flows, seed cast (Priya/Maya/Theo/Sam, 2 workspaces), the
  revoke choreography, and the view-model contract the client package must
  expose. High-fidelity mockups: docs/design/mockups.html, published as a
  Claude artifact:
  https://claude.ai/code/artifact/0a897e70-57a3-4184-b8bd-613499eb1569

- **Stage 5 (architecture).** ADRs 001–007 ratified: sans-IO cores with an
  effect model (client storage async+barriered, server storage synchronous
  injected); protocol v1 messages with op identity gapless per
  (clientId, workspaceId), per-workspace seq, {seq, epoch} cursors, and an
  incremental≡snapshot equivalence guarantee; declarative JSON ruleset with
  a single branded-type evaluation point in the sync path; explicit
  idempotent forget with epoch bumps, mark/counter resets, and a
  receive-time staleness check for hibernation-surviving sockets; per-field
  LWW stamped by server seq with two-channel outbox retirement; schema
  negotiation with total op migrators and the old-code vs old-store split;
  DO topology (WorkspaceDO + DirectoryDO with at-least-once membership
  propagation) behind one adapter interface with Node parity. An
  adversarial cross-consistency review found 24 findings (7 must-fix
  contract contradictions, incl. the forget-vs-gap-rule clash, the missing
  live-epoch-change mechanism, and the unspecified invite propagation) —
  all resolved with canonical rulings before ratification.

- **Stage 7 (repo + CI).** Public repo `github.com/imSuvro/syncline`; main
  protected (required contexts lint/typecheck/test/pack, no reviews — solo,
  force-push disabled, admins not enforced as the emergency hatch); 8
  workspaces scaffolded with strict TS project references; determinism lint
  ban live (protocol, client/core, server, harness, demo-schema; CLI
  carve-out keeps IO but never clocks/randomness); attw esm-only pack checks
  green for both publishable packages; spike deleted per backlog. Stage
  branches merge via PR from here on.

- **Stage 8 (server foundation).** `@syncline/protocol` is real: strict
  frame codecs (malformed input → null, never throws), the permission
  evaluator + `validateRuleset` (write⟹read), per-field LWW merge with
  tombstone-wins — 19 unit tests. `@syncline/server`: the one adapter
  interface, the branded-`Permitted` permit module, and a WorkspaceCore
  covering hello (snapshot/incremental/AUTH_FAILED/BAD_CURSOR/VERSION_TOO_NEW),
  idempotent push with gap detection and mark-advancing rejections,
  broadcast with own-op echo through the permit path, presence, and the
  full ADR-004 revocation choreography (forget → REVOKED close, mark
  clears, epoch bumps, re-invite fresh-epoch snapshot, receive-time
  staleness eviction) — 17 core tests. Node adapter live-smoked end-to-end
  (login → snapshot(25 rows) → push → ack seq=26 → echo) over node:sqlite +
  ws. Cloudflare adapter (DO SQLite storage, hibernation sockets,
  DirectoryDO login) compiles under workers-types. ADR-008 (JWT HS256 at
  edges) accepted. **Design ruling from a failing test**: membership rows
  are keyed by minted per-episode rowIds — ADR-005's never-resurrect rule
  would otherwise swallow re-invites; amended into ADR-004.

- **Stage 9 (sync server).** Harness v1 is live: seeded splitmix32→
  xoshiro128** with derived per-concern streams, virtual-time heap
  scheduler, FIFO fake transport (a real bug found here: independent
  per-frame delays reordered helloAck/snapshot and the determinism test
  caught the convergence break — WebSocket ordering is now modeled
  faithfully), a reference client as the protocol's second independent
  implementation, and a structured trace with FNV-1a hashing. Six
  end-to-end integration tests: reconnect cursor backfill, lost-ack
  duplicate replay (server byte-identical), incremental≡snapshot
  equivalence, revoke-mid-session + re-invite over the wire, join
  mid-history, and same-seed→identical-trace/different-seed→different-trace.
  Directory propagation (C6) is live in both adapters: node drains the
  workspace outbox into an in-process membership view; Cloudflare flushes
  WorkspaceDO→DirectoryDO with alarm retry, DirectoryDO keeps the dynamic
  membership table in its own SQLite. 42 tests total.

- **Stage 10 (client engine).** `@syncline/client` core is complete and
  sans-IO: durable outbox with the write-barrier-before-send contract
  (asserted by effect ordering, not by convention), optimistic base+overlay
  view, two-channel retirement (ack results + own-op echo), cursor
  catch-up, transactional forget, EPOCH_CHANGED→snapshot re-entry, ping
  liveness and exponential reconnect backoff. Browser adapters written:
  IndexedDB storage (one atomic transaction per batch — its completion IS
  the durability point), WebSocket transport, and a runtime that serializes
  steps and awaits barriers before releasing sends. Nine core tests using a
  crash-simulating fake store. **Two real bugs found by those tests**:
  (1) `lastSentOpId` survived across sessions, so a reconnect that took the
  snapshot path silently failed to replay the outbox — an acknowledged-write
  loss path, fixed by resetting it on every `helloAck`; (2) the optimistic
  overlay dropped updates to rows absent from `base`, hiding an author's own
  offline edit after a purge — now the overlay synthesizes the row.

- **Stage 11 (partial replication + permissions — the heart).** The
  "bypass is a compile error" claim is now true rather than aspirational:
  the arrays feeding `snapshot`/`ops` frames are declared `Permitted<T>[]`,
  and only `permit.ts` can mint that brand, so an unfiltered row cannot
  reach a data frame without failing the build. Three source-level guards
  back it up (single minting site, branded payload declarations, evaluator
  reachable only through permit). Field masking verified across both paths
  — an owner-only field is absent from an editor's snapshot *and* from
  live ops, is rejected on write from the role that cannot read it, and
  leaves each principal converged to its own slice rather than a shared
  one. Live narrowing (promote → demote) closes the connection with
  EPOCH_CHANGED and re-syncs a genuinely narrower snapshot. **Invariant (b)
  now has a wiretap**: every outbound data frame is independently
  re-evaluated at send time against a freshly read membership, so a leak
  inside the sync path is caught even when the server believes it filtered
  correctly — proven by planting two deliberate bypasses (a snapshot built
  with another principal's permissions, and a data frame to a revoked
  user), both caught, while an honest revoke-and-reinvite run stays silent.
  61 tests.

- **Stage 12 (conflicts + migration).** The demo schema now ships two real
  versions: v2 renames `issues.priority` to `issues.severity` and
  normalizes `med`→`medium` — a field rename, chosen deliberately because
  it makes v1 op payloads *unapplyable* as-is, so the migrators have to
  actually work. Both migrators are total by type (`Op`, never `Op | null`),
  which is what turns "no acknowledged write is lost across a migration"
  into a property of the signature rather than a promise. Server accepts
  ops in [minWritable, current] and migrates on arrival; below the floor is
  a per-op `rejected: "version"` in pushAck, never a bare error frame;
  above the ceiling is a fatal VERSION_TOO_NEW. **The mandated test passes**:
  a v1 client goes offline, queues four v1-shaped writes (including one to
  the renamed field and a create), the world advances at v2 meanwhile, the
  client upgrades — migrating local rows and every queued op while
  preserving identities — reconnects, and all four land in migrated form
  with nothing rejected, nothing dropped, the witness's concurrent write
  intact, and everyone converged. LWW verified for different-field merges,
  same-field races resolving identically on both clients by server order,
  stale offline edits landing last, and convergence across five seeded
  interleavings with connection drops. 70 tests.

- **Stage 13 (demo app).** Vite + React issue tracker on `@syncline/client`,
  built to docs/ux.md and the mockups: login-as picker (no signup), sidebar
  with live workspace list and member panel, inline issue editing, the
  connection pill with its demo-only offline toggle, pending badge,
  presence dots, attribution flashes, the sync ticker, invite/revoke with
  the confirm dialog, and the removal card. **Verified live in two browser
  sessions against the running server** — not merely built: (a) Maya edits
  offline, the pill reads `offline · 1 saved locally` and the row shows
  pending while nothing goes out; on reconnect the ticker shows
  `▲ push op=1 status` then `▼ seq=26`, the badge clears, and Priya's tab
  independently shows the same value — offline convergence proven across
  clients; (b) Priya revokes Maya, and Maya's tab prints
  `▼ seq=26 forget workspace=acme`, drops all 22 issues, shows the removal
  card, and her IndexedDB for that workspace comes back with zero rows and
  zero outbox entries — the revoke moment, working. Three real bugs found
  by driving the actual UI: a React memo keyed on a stable setter froze
  every engine snapshot at first render (the pending badge never moved); a
  rejected storage batch could poison the effect chain and silently freeze
  the client forever (now caught and surfaced); and storage batches raced
  instead of queueing, so a snapshot's clearAll could overtake the rows
  written after it.

## NEEDS-HUMAN

- **DECISION REQUIRED: server hosting** (from stage 1b, `docs/adr/000-hosting.md`).
  *Recommendation:* Cloudflare Workers + SQLite-backed Durable Objects — the only
  option satisfying every hard constraint and technical requirement at once:
  SQLite DOs are on the free plan (100k req/day, 13k GB-s/day, 5M row-reads +
  100k row-writes/day, 5 GB), the WebSocket Hibernation API holds connections
  at zero duration cost (incoming billed 20:1, outgoing free, ~2M incoming
  msgs/day headroom), nothing sleeps into a wake delay, overruns fail with
  errors instead of charges, and it needs zero new accounts and zero card —
  wrangler is already logged in on this machine. Runner-up Railway is only
  free for ~30 days; Render wakes for ~60 s after 15 idle minutes and its free
  Postgres expires in 30 days; Supabase Realtime can't host our authority
  logic; Fly requires a card. Full comparison in the ADR.
  *Setup steps per option:*
  - **(a) Cloudflare (recommended — already satisfied, nothing to do):**
    1. Verify: run `npx wrangler whoami` → expect "You are logged in with an
       OAuth Token, associated with the email suvro.samajder@gmail.com" and an
       account table with workers write scope. That's it.
    2. Only if step 1 ever fails: `npx wrangler login` → browser opens a
       dash.cloudflare.com consent page → click "Allow" → terminal prints
       "Successfully logged in." → re-run `npx wrangler whoami` to verify.
  - **(b) Railway (rank 2, ~30 free days):**
    1. Open https://railway.com → "Login" → "Sign in with GitHub" → click
       "Authorize Railway" (GitHub-verified accounts get the full $5/30-day
       trial; no card).
    2. `npm i -g @railway/cli` → `railway login` → browser opens → click
       "Verify" → terminal shows "Logged in as <name>".
    3. `railway init` (name the project) → `railway up` → expect build logs
       ending in a live deployment.
    4. Dashboard → service → Settings → Networking → "Generate Domain" →
       yields the `wss://….up.railway.app` endpoint.
    5. Note: trial volumes are deleted 30 days after credit expiry; the $1/mo
       free plan sustains an always-on service only ~5–6 days/month.
  - **(c) Render (rank 3, free forever but ~60 s wake after 15 idle min):**
    1. Open https://dashboard.render.com/register → "Sign up with GitHub" →
       authorize → verify email (officially card-free; an anti-abuse card
       prompt may appear — it is not charged).
    2. Dashboard → "New +" → "Web Service" → connect the GitHub repo →
       Instance Type "Free" → "Create Web Service" → wait for "Live" at
       `https://<name>.onrender.com` (wss:// works on it).
    3. Optional DB: "New +" → "Postgres" → "Free" → "Create Database"; set a
       calendar reminder — it expires 30 days after creation (+14-day grace).
  - **(d) Supabase (rank 4, transport mismatch — listed for completeness):**
    1. https://supabase.com/dashboard → "Sign in with GitHub" → "Authorize
       supabase" → "New project" → free org → name/password/region → wait
       ~2 min.
    2. Settings → API → copy project URL + anon key; Realtime ceilings: 200
       concurrent, 100 msg/s, 2M msgs/month; project pauses after ~1 idle
       week (manual "Resume project" in dashboard).
  - **(e) Fly.io: not actionable** — requires a credit card or $25 minimum
    prepaid credits; violates the $0/no-card constraint. Do not proceed.
  *Default if no answer arrives:* stage 8 builds against **option (a),
  Cloudflare**, per the zero-new-accounts/zero-card rule. Since (a) needs no
  human steps, this decision only requires action if you want a DIFFERENT
  platform.
