# ADR-000 — Sync server hosting: Cloudflare Workers + SQLite-backed Durable Objects

- Status: Accepted (default pending human confirmation — see PROJECT_LOG NEEDS-HUMAN)
- Date: 2026-08-29
- Deciders: Suvra Samajder

## Context

The sync server needs persistent WebSocket connections, a small database, and
low cold-start impact on sync latency (a sync engine that takes a minute to
wake is indistinguishable from a broken one). Hard constraints: **$0 spend, no
credit card, prefer zero new accounts**. Existing assets: a Cloudflare account
(Workers used previously; `wrangler whoami` already succeeds on the dev
machine) and an authenticated Vercel session (hosts the demo frontend only —
Vercel functions are not a persistent-WebSocket host and are not an option
here).

Five candidates were compared with free-tier limits verified from official
pricing/docs pages fetched 2026-08-29 (full source list at the end). Scores
are 1–5 on: persistent WebSocket support (WS), free-tier ceilings (Ceil),
cold-start impact (Cold), account/card fit (Fit).

## Comparison

| Rank | Option | WS | Ceil | Cold | Fit | Total | Summary |
|---|---|---|---|---|---|---|---|
| 1 | **Cloudflare Workers + DO SQLite** | 5 | 5 | 5 | 5 | **20** | Free SQLite DOs, hibernating WebSockets, nothing sleeps, no card, already logged in |
| 2 | Railway | 5 | 2 | 4 | 3 | 14 | $5/30-day no-card trial, then $1/mo credit ≈ 5–6 days uptime; trial volumes deleted 30 days post-expiry |
| 3 | Render | 4 | 3 | 1 | 3 | 11 | Perpetually free, but 15-min idle spin-down → ~60 s wake; free Postgres expires after 30 days (+14 grace) |
| 4 | Supabase | 2 | 3 | 2 | 4 | 11 | Free forever, but Realtime is managed pub/sub (no server-side merge logic on the socket); project pauses after 1 idle week |
| 5 | Fly.io | 5 | 1 | 3 | 1 | 10 | No free tier for new users; card on file required (or $25 minimum prepaid credits); trial = 2 h runtime |

### (a) Cloudflare Workers + Durable Objects — chosen

Verified free-plan facts:

- **SQLite-backed Durable Objects are on the free plan** ("Workers Free plan:
  Only Durable Objects with SQLite storage backend are available" — the
  key-value backend is paid-only). The database lives inside the workspace DO;
  **D1 is not needed** (one storage product, one consistency domain).
- **Requests**: 100,000/day Workers + 100,000/day DO (HTTP, RPC, WebSocket
  messages, alarms). **Duration**: 13,000 GB-s/day.
- **DO SQLite storage**: 5M rows read/day, **100k rows written/day**, 5 GB per
  account (10 GB per object).
- **WebSockets**: incoming messages billed **20:1** as requests ("100
  WebSocket incoming messages would be charged as 5 requests"); outgoing
  messages and protocol pings free. Derived headroom: ~2M incoming WS
  messages/day.
- **Hibernation API**: duration charges stop while hibernated; "WebSocket
  clients remain connected to the Cloudflare network" and the DO wakes
  automatically on the next message. Consequence: the server MUST use the
  Hibernation API (a naïve `accept()` bills duration for the connection's
  entire lifetime), and connection state must survive eviction via
  per-connection attachments.
- **Cold start**: V8 isolate model — no VM-style cold starts; hibernation wake
  preserves connections (no published ms figure, no published numeric per-DO
  connection cap; official docs say "thousands of clients per instance").
- **Overage**: operations "fail with an error" — hard stop, never surprise
  billing. Fits $0 absolutely.
- **Account fit**: zero new accounts, zero card — `wrangler whoami` already
  succeeds on the dev machine.

Watch-items (mitigations owned by ADR-007, server runtime design):

1. **100k rows written/day** is the binding constraint for a chatty sync
   engine → batch row writes per sync message (op-log row + materialized row +
   coalesced meta), keep cursor checkpoints coalesced. Demo traffic is orders
   of magnitude below the cap; the math goes in ADR-007.
2. Incoming 20:1 WS billing → clients batch pushes; broadcasts (outgoing) are
   free.
3. Hibernation constrains design → per-connection attachments
   `{principal, cursor, epoch}` + a core `rehydrateConnection` path, fuzz-covered
   by a "hibernate" fault in the stage-14 harness.

### (b) Fly.io — disqualified

No free tier for new users (legacy plans discontinued). Card on file required;
the only alternative is prepaid credits with a **$25 minimum** — violates $0
and no-card outright. Trial is 2 h of machine runtime / 7 days with a 5-minute
auto-stop. Technically excellent WebSocket support is irrelevant given the
constraints.

### (c) Railway — best no-card runner-up, time-boxed

$5 one-time trial credit, 30 days, no card, then a Free plan with $1/month —
at $10/GB-RAM/mo + $20/vCPU/mo that sustains a minimal always-on service
~5–6 days per month. WebSockets are first-class (exempt from request
timeouts); sleep is opt-in only. Trial volumes are deleted 30 days after
credit expiry. Fine for a month-long demo, wrong for a portfolio link that
must stay alive.

### (d) Render — free forever, wrong latency profile

Free web service spins down after **15 idle minutes**; spin-up "takes about a
minute" — the antithesis of sync latency (the demo's first impression would be
a 60-second hang). 750 instance-hours/month covers one always-on service, and
WebSocket messages count as keep-alive activity, but any idle gap pays the
wake tax. Free Postgres **expires 30 days after creation** (14-day grace).
Officially no card; community reports occasional card-verification prompts.

### (e) Supabase — transport mismatch

Free plan: 500 MB database, 2 projects, pauses after ~1 idle week (manual
dashboard resume). Realtime free tier: 200 concurrent connections, 100
msgs/sec, 2M messages/month, 256 KB payloads. Decisive problem: Realtime is
managed pub/sub — the sync server's own authority logic (server-assigned
ordering, permission evaluation per outbound op, forget push) cannot run on
the socket path; it would have to be bolted onto Postgres functions + polling,
abandoning the architecture. 2M msgs/month is also a hard monthly ceiling vs
Cloudflare's ~2M/day equivalent.

## Decision

**Cloudflare Workers + SQLite-backed Durable Objects.** One `WorkspaceDO` per
workspace holds that workspace's op log, rows, memberships, and subscriptions
in DO SQLite and serves its WebSockets via the Hibernation API; a small
`DirectoryDO` handles demo users/workspace directory/JWT mint. All
platform-specific code sits behind the one adapter interface in
`packages/server/src/adapter.ts` (ADR-001/007), so this decision touches
exactly one directory (`apps/server-cf`) and a hosting switch to the rank-2
option (Railway, via the Node adapter `packages/server-node`) is a
NEEDS-HUMAN walkthrough away.

This is the stated **default** under the brief's rule (prefer zero new
accounts, zero card). It is recorded as DECISION REQUIRED in PROJECT_LOG
NEEDS-HUMAN with per-option setup walkthroughs; absent an answer, stage 8
builds against this default.

## Consequences

- Free-tier ceilings become design inputs: write batching per sync message,
  client push batching, hibernation-safe connection rehydration — all
  enforced by tests, not hope.
- Nothing to keep alive, nothing that sleeps into a 60-second wake, no
  monthly credit clock, no card anywhere.
- If the demo ever outgrows 100k row-writes/day or 100k requests/day, it
  fails loudly (Cloudflare errors) rather than billing; the reconnect banner
  (docs/ux.md) is the honest UX for that edge.
- The unpublished per-DO connection cap ("thousands") is far above demo scale.

## Sources (all fetched 2026-08-29)

- https://developers.cloudflare.com/durable-objects/platform/pricing/ — SQLite DOs free; request/duration/read/write/storage caps; 20:1 incoming WS billing; hibernation not billed; limit-exceeded = errors
- https://developers.cloudflare.com/workers/platform/pricing/ — Workers free tier
- https://developers.cloudflare.com/durable-objects/platform/limits/ — per-object caps, WS message size
- https://developers.cloudflare.com/durable-objects/best-practices/websockets/ — Hibernation API semantics
- https://developers.cloudflare.com/workers/reference/how-workers-works/ — isolate model, cold starts
- https://developers.cloudflare.com/d1/platform/limits/ and /d1/platform/pricing/ — D1 free tier (evaluated, not used)
- https://fly.io/docs/about/pricing/ · /about/billing/ · /about/free-trial/ · /launch/autostop-autostart/
- https://railway.com/pricing · https://docs.railway.com/reference/pricing/free-trial · /reference/pricing/plans · /reference/app-sleeping
- https://render.com/docs/free · /docs/compute-plans · render.com/articles/platforms-with-a-real-free-tier-for-developers-in-2026
- https://supabase.com/pricing · /docs/guides/platform/free-project-pausing · /docs/guides/realtime/quotas

Unverified gaps, noted honestly: Cloudflare/Supabase card-free signup is not
stated on their own fetched pages (Cloudflare's is corroborated by Render's
2026 comparison article and moot — the account exists); no official numeric
per-DO WebSocket connection cap; Render's included monthly bandwidth figure
not captured; Fly publishes no cold-start milliseconds.
