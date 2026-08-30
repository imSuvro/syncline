# ADR-003 — Permission rules and the single evaluation point

- Status: Accepted
- Date: 2026-08-29
- Deciders: Suvra Samajder

## Context

The project's core constraint: permission checks live in the sync layer,
never only in request handlers — any bypass path is a bug. That demands (a)
a permission representation both server and client can evaluate
identically, and (b) a structural guarantee that no data leaves the server
without passing it.

## Decision

**Representation**: a declarative, JSON-serializable `Ruleset` in
`@syncline/protocol` — data, not code. Rules are role-based row + field
rules per table, composed from a closed set of built-in predicates (no
arbitrary functions — the ruleset must be documentable in docs/protocol.md
and evaluable identically everywhere):

```ts
type Role = 'owner' | 'editor' | 'viewer';
type Ruleset = {
  version: number;
  tables: {
    [table: string]: {
      read:  RolePredicate;              // row visibility
      readFields?: { [field: string]: RolePredicate };  // field masking
      write: { [field: string]: RolePredicate } | RolePredicate;
      create?: RolePredicate; delete?: RolePredicate;
    };
  };
};
type RolePredicate =
  | { kind: 'role'; atLeast: Role }      // owner > editor > viewer
  | { kind: 'member' }                   // any workspace membership
  | { kind: 'self'; field: string }      // row[field] === principal.userId
  | { kind: 'any'; of: RolePredicate[] }
  | { kind: 'never' };
```

The demo ruleset (in `syncline-demo-schema`): `issues` — read `member`,
write-fields `editor`+; `memberships` — read `member`, create/delete/role
changes `owner` (self-removal allowed via `self`).

**The evaluator** lives in `@syncline/protocol` as a pure function:

```ts
evaluate(ruleset, principal: {userId, role}, table, row)
  -> { read: boolean; fieldMask?: string[] }
canWrite(ruleset, principal, op) -> boolean
```

One implementation, three consumers: the server sync path (authoritative),
the client (pre-flight UX checks — advisory only), and the harness
(invariant b: the wiretap re-evaluates every outbound frame, and the
quiescent check re-evaluates every row every client holds).

**The single evaluation point, structurally enforced**: in the server core,
the only constructor for an outbound data payload is

```ts
permitFor(principal, ruleset, table, row | op) -> Permitted<T> | null
```

and the `send` effect for `snapshot`/`ops` frames accepts only
`Permitted<T>` values. `Permitted` is an opaque branded type created
nowhere else. Evaluation happens **per outbound op per connection at send
time** (and per row at snapshot time) — role is read live from the
membership row, never from the JWT and never from a connection attachment
(ADR-004/007 depend on this: the token proves identity; the sync layer
decides visibility, every time). Field masking applies inside multi-field
`create` payloads exactly as it does to rows. Writes are checked at push
time with `canWrite` before append; rejected ops return
`rejected: "forbidden"` in `pushAck`, are never appended, and still advance
the dedup mark (ADR-002) — the client drops the entry, reverts its
optimistic overlay, and emits an `op-rejected` event.

**Ruleset validity, enforced at load** (`validateRuleset()` in protocol):
any field writable by role R must be readable by role R — write-without-
read is rejected as a configuration error, because a writer whose own-op
echo is masked away could never retire its optimistic state coherently.

A CI grep-test (stage 11) additionally asserts no `send`-effect
construction site outside the permit module — belt and braces.

## Options considered

- **Arbitrary predicate functions** (Zero-style server query rewriting) —
  rejected: not serializable, not documentable as protocol, not evaluable
  by the harness without executing app code.
- **SQL/where-clause rules** (ElectricSQL shapes, PowerSync parameter
  queries) — rejected for v1: syncline's unit is the workspace with
  role-based masking; a predicate DSL over rows covers the demo domain with
  a fraction of the spec surface. The `RolePredicate` union is the seam
  where richer predicates would land later.
- **Enforce in request handlers only** — forbidden by the brief; it is the
  bug class this project exists to demonstrate against.

## Consequences

- Permission semantics are part of the wire contract: docs/protocol.md
  documents the predicate vocabulary and evaluation rules, so a stranger's
  client can predict visibility.
- Field masking means two members can hold different projections of the
  same row; snapshots and ops are masked per connection — cheap at demo
  scale, and the honest cost of the feature.
- Ruleset changes are schema-version events (ADR-006) — the ruleset ships
  with `syncline-demo-schema`, versioned alongside the tables; a ruleset
  change that narrows visibility bumps affected epochs (ADR-004).
