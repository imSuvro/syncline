# syncline — handoff

Written 2026-08-30, at the end of a session that took the project from an
empty directory through stage 10 of 17. Everything described here is
committed, pushed, and green on CI. Read `PROJECT_LOG.md` for the decision
history and `docs/backlog.md` for the work items; this file is the "where
you are and what to do next" note.

## Where the project stands

**Stages 1–10 of 17 are done, merged to `main` via PR, and tagged
`v0.1`–`v0.11`.** Repo: https://github.com/imSuvro/syncline (public, `main`
protected, four required CI contexts: lint / typecheck / test / pack).

| Done | Stage | Artifact |
|---|---|---|
| ✅ | 1 Research | `docs/research.md` — six sync engines surveyed, gap statement |
| ✅ | 1b Hosting | `docs/adr/000-hosting.md` — Cloudflare Workers + DO SQLite, verified free-tier numbers |
| ✅ | 2 PRD | `docs/PRD.md` |
| ✅ | 3 Spike | numbers in PROJECT_LOG (spike deleted at stage 7, as planned) |
| ✅ | 4 UX | `docs/ux.md` + `docs/design/mockups.html` ([artifact](https://claude.ai/code/artifact/0a897e70-57a3-4184-b8bd-613499eb1569)) |
| ✅ | 5 Architecture | `docs/adr/001`–`007` + `008` (auth), ratified after an adversarial review that found 24 contract issues |
| ✅ | 6 Backlog | `docs/backlog.md` — epics A–K with DoD per item |
| ✅ | 7 Repo + CI | 8-workspace pnpm monorepo, strict TS, determinism lint ban, GitHub Actions |
| ✅ | 8 Server foundation | `@syncline/protocol` + `@syncline/server` + both adapters |
| ✅ | 9 Sync server | deterministic harness v1 + integration suite |
| ✅ | 10 Client engine | `@syncline/client` core + browser adapters |
| ⬜ | 11 Partial replication + permissions | **next** |
| ⬜ | 12 Conflicts + migration | |
| ⬜ | 13 Demo app | |
| ⬜ | 14 Testing (fuzz campaign) | |
| ⬜ | 15 Review | |
| ⬜ | 16 Deploy | |
| ⬜ | 17 Launch | |

51 tests pass. No known failing behavior.

## What actually works today

You can run the sync server locally and drive it end to end:

```bash
cd D:\Personal\syncline && pnpm install && pnpm build
```

```bash
node --experimental-sqlite --import tsx packages/server-node/src/main.ts
```

That serves `http://localhost:8787` with `POST /auth/login {userId}`,
`GET /directory?userId=`, and `ws://localhost:8787/ws/:workspaceId`. It was
smoke-tested live this session: login → snapshot of 25 seeded rows → push →
ack with server seq → own-op echo.

Verified by the test suite (not by assertion in prose):

- **Permission-aware sync**: every outbound op passes the shared evaluator;
  viewers' writes come back `rejected: forbidden`; the branded `Permitted<T>`
  type means a bypass is a compile error.
- **Revocation → forget**: revoke pushes `forget` then closes with
  `REVOKED`, clears server dedup marks, bumps the epoch; the client purges
  rows + outbox + cursor + counter in one barrier; re-invite bootstraps a
  fresh snapshot with no stale resurrection; an offline revoked client gets
  the forget at its next handshake.
- **Idempotent push**: duplicate replay leaves the server byte-identical;
  an opId gap is a loud `OP_GAP` error, never silent loss.
- **incremental ≡ snapshot**: catch-up from any cursor equals a fresh
  snapshot at the same head.
- **Durable outbox**: ops are barriered to storage *before* any send; a
  crash before ack replays them exactly once on reboot.
- **Determinism**: same seed → byte-identical trace hash; different seed →
  different trace.

## The next thing to do

**Stage 11 (Epic E in `docs/backlog.md`) — partial replication + permissions.**
Much of its substance already landed early (the permit path and the
revocation choreography are implemented and tested at the core level), so
stage 11 is mostly *proving* and *hardening*:

1. **E1** — add the CI grep-test asserting no `send`-effect construction
   site exists outside `packages/server/src/permit.ts`, and add the
   field-masking matrix tests (a ruleset with `readFields`, two principals,
   assert masked snapshots and masked op echoes).
2. **E2/E3** — the three mandated integration tests already exist in
   `packages/harness/test/sync.test.ts` (join mid-history, revoke
   mid-session, re-invite). Extend them to cover *field-level* narrowing
   (role change editor→viewer with a masked ruleset).
3. **E4** — the invariant-(b) wiretap: in `World.executeEffect`, re-run
   `evaluate` on every outbound frame and throw on any row/field the
   principal may not see; then plant a deliberate bypass and prove the
   wiretap catches it.

Then stage 12 (LWW property tests + the schema-migration replay test),
stage 13 (the demo app — `docs/ux.md` and the mockups are the spec, and
`SynclineClient` already exposes exactly the view-model contract that file
describes), stage 14 (fault knobs + fuzz campaign + `fuzz-smoke` as a fifth
required CI context), then review/deploy/launch.

## Things you should know before continuing

- **The client engine is not yet wired into the harness.** The harness
  drives a deliberately separate `RefClient` (a second, independent
  implementation of the protocol — useful for validating
  `docs/protocol.md`). Stage 14 should run campaigns against the *real*
  `@syncline/client` core; the seam is `World.connect()`, which only needs
  something with `attach({send})` and `onFrame()`.
- **`packages/server-node` needs `--experimental-sqlite` on Node 22.**
  Node 23.4+ drops the flag. If `node:sqlite` ever misbehaves, the escape
  hatch is `better-sqlite3` — same synchronous shape.
- **The Cloudflare adapter compiles but has never been deployed.**
  `wrangler.jsonc` is written; `wrangler whoami` already succeeds on this
  machine (OAuth, suvro.samajder@gmail.com, workers write scope), so the
  stage-16 "legitimate halt" condition is pre-cleared. Deploy needs one
  secret: `wrangler secret put JWT_SECRET`.
- **Two ADR amendments came from failing tests**, and both are recorded:
  membership rows are keyed by minted per-episode rowIds (ADR-004
  amendment), and the harness transport must model FIFO per direction
  (PROJECT_LOG stage-9 note). Trust the tests over your memory of the ADRs.
- **The determinism lint ban is load-bearing**, not decoration. It is what
  makes the stage-14 fuzz campaign possible. If you find yourself wanting
  `Date.now()` in `packages/{protocol,server,harness}/src` or
  `packages/client/src/core`, the answer is to thread it through an input.

## Open human-gated items

Only one, and it is not blocking until stage 17: **npm publish auth**
(`npm login` + creating the free `@syncline` org so the scope isn't sniped).
The full numbered walkthrough will be written into PROJECT_LOG's NEEDS-HUMAN
section at stage 17. The hosting decision entry there is informational — its
recommended option needs no human action, since wrangler is already
authenticated.
