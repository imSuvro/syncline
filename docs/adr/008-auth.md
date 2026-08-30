# ADR-008 — Authentication: HS256 JWT at the edges

- Status: Accepted
- Date: 2026-08-30
- Deciders: Suvra Samajder

## Context

The demo has pre-seeded accounts behind a login-as picker (no signup wall,
PRD). The sync layer needs to know *who* a connection is; it deliberately
does not trust tokens for *what they may see* — authorization is evaluated
live on every outbound op (ADR-003), and revocation never depends on token
invalidation (ADR-004). That frees authentication to be minimal.

## Decision

- **Format**: JWT, HS256, claims `{sub: userId, iat, exp}`, 24h expiry.
  Secret via `wrangler secret put JWT_SECRET` (Cloudflare) / `JWT_SECRET`
  env var (Node adapter; dev default baked in for local runs).
- **Mint**: `POST /auth/login {userId}` on the directory (DirectoryDO /
  Node HTTP) validates the userId against the seeded demo cast and returns
  the token. No passwords — the demo's threat model is "pick a persona,"
  and the README says so.
- **Verify at the edges only**: the Node adapter uses `node:crypto` HMAC,
  the Cloudflare adapter uses WebCrypto (`crypto.subtle`) — two ~40-line
  mirrors (`server-node/src/jwt.ts`, `server-cf/src/jwt.ts`), kept twin by
  the parity test suite. Crypto never enters `@syncline/server` (the
  determinism ban forbids it); the core receives only a verified `userId`.

## Options considered

- **Session store** — rejected: a stateful lookup per connection buys
  nothing here (revocation doesn't use it) and costs a cross-object hop on
  Workers.
- **Long-lived tokens without expiry** — rejected: 24h expiry bounds
  drive-by token reuse at zero UX cost (the picker re-logins in one click).
- **Asymmetric JWT (RS/EdDSA)** — rejected: one issuer, one audience; key
  distribution machinery with no second party to serve.

## Consequences

- A leaked token impersonates a demo persona for ≤24h — but sees only what
  the sync layer permits that persona *right now*, which is the point of
  the project.
- Stage-16 deploy needs exactly one secret in exactly one place.
