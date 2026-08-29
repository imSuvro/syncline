# syncline — project log

Local-first sync engine with permission-aware partial replication, shipped as
npm packages (`@syncline/protocol`, `@syncline/client`) plus a team issue
tracker demo that makes partial sync and permission revocation visible: revoke
a member in one browser and their local data vanishes in the other.

## Stage status

| # | Stage | Role | Status | Tag |
|----|-------|------|--------|-----|
| 1 | Research | Product Owner | done | v0.1 |
| 1b | Hosting research | Architect | in progress | |
| 2 | Product definition (PRD) | Product Owner | pending | |
| 3 | Feasibility spike | Architect | pending | |
| 4 | UX | UX Designer | pending | |
| 5 | Architecture (ADRs) | Architect | pending | |
| 6 | Planning (backlog) | Product Owner | pending | |
| 7 | Repo + CI | DevOps | pending | |
| 8 | Server foundation | Dev | pending | |
| 9 | Sync server | Dev | pending | |
| 10 | Client engine | Dev | pending | |
| 11 | Partial replication + permissions | Dev | pending | |
| 12 | Conflicts + migration | Dev | pending | |
| 13 | Demo app | Dev | pending | |
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

## NEEDS-HUMAN

(none yet)
