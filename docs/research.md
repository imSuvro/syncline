# Sync-engine landscape research

Stage 1 deliverable. Six systems surveyed — Replicache, Zero, Linear's sync
engine, ElectricSQL, PowerSync, Automerge — with one question held constant:
**how does each handle partial replication and permissions, and what actually
happens to a client's local data when its permission is revoked?** All claims
below trace to the cited sources, fetched 2026-08-29. Where something is
undocumented, that is stated rather than guessed, because the gap analysis at
the end depends on it.

## Replicache

**Status.** replicache.dev now states: "Replicache is now in maintenance
mode… We have shifted focus to Zero… Existing users should migrate to Zero as
they are able." Its documentation remains the field's best reference design.

**Architecture.** A client-side TypeScript library plus a protocol you
implement on your own backend (the original "diff server" middleman was
deprecated in 2021). The client holds the "Client View" — "an ordered map of
key/value pairs" in an IndexedDB-backed store with "git-like" internals.
"In Replicache, the server is authoritative": writes are **mutators** (named
functions) that run instantly against the local store; each invocation is
recorded as a mutation `(clientID, per-client sequential id, name, args)`,
batched to your push endpoint, where the server re-executes its own (possibly
different) version of each mutator. On pull the client "rewinds the state of
the Client View to the last version it got from the server, applies the
patch… and then replays any pending mutations on top" — server-authoritative
rebase. A server-sent "poke" (empty hint) triggers immediate pulls.
"Applications can go offline for hours or days and sync up smoothly."

**Partial replication.** Framed explicitly as two problems: "Read Auth: When
not all data is accessible to all users" and "Partial Sync: When a user only
syncs some of the data they have access to." Four documented backend
strategies: Reset, Global Version (~50 pushes/sec app-wide), Per-Space
Version (the "spaces" pattern — "all users in a space sync that space in its
entirety"), and **Row Version**, the recommended strategy for "fine-grained
read authorization, or partial sync." Row Version works via Client View
Records (CVRs): each pull, the server runs the client-view query ("any
arbitrary function of the DB, including read authorization, paging, etc."),
builds a `nextCVR` of id→version pairs, diffs it against the stored
`baseCVR`, and emits put/del patch ops — no global locks, no soft deletes, at
the cost of "increased implementation complexity and read cost."

**Permissions and revocation.** Enforcement lives entirely in your own
push/pull handlers — Replicache ships no permission layer (docs prescribe
verifying "that the clientID passed in the request in fact belongs to that
user"). Under Row Version, a row the user can no longer see drops out of
`nextCVR` and the diff emits a `del` on the client's **next pull** — removal
is structural but *passive* (pull-triggered; a poke can only prompt the pull
sooner). The docs describe the mechanism but never discuss revocation as a
scenario, state no removal guarantee, and define no forget semantics in the
protocol. Under Global/Per-Space strategies, revocation is undocumented
entirely.

**Protocol documentation.** Best of the six on the server side: normative
pull spec (request `{pullVersion, clientGroupID, cookie, profileID,
schemaVersion}`; response `{cookie, lastMutationIDChanges, patch}` with
exactly three ops `put`/`del`/`clear`; orderable cookies; defined errors) and
push spec ("The effects of a mutation and the corresponding update to
lastMutationID must be revealed atomically"; idempotency rules;
poison-mutation handling). Sufficient to implement a compatible **server**;
an independent **client** is not fully specified (client-group formation,
persistence format, exact rebase behavior are conceptual only).

**Conflicts, ordering, migration.** No CRDTs: "Mutators are arbitrary
JavaScript code, so they can programmatically express whatever conflict
resolution policy makes the most sense" — server execution wins, client
results are speculative. Upstream order: per-client monotonic mutation IDs
with `lastMutationID` high-water marks; downstream: the orderable cookie.
`schemaVersion` rides both push and pull, servers can answer
`VersionNotSupported`, and "for brief periods during schema migrations, two
client groups can coexist in the same browser profile" — but no automatic
pending-mutation transformation exists or is claimed.

Sources: [how it works](https://doc.replicache.dev/concepts/how-it-works) ·
[server pull](https://doc.replicache.dev/reference/server-pull) ·
[server push](https://doc.replicache.dev/reference/server-push) ·
[strategies overview](https://doc.replicache.dev/strategies/overview) ·
[row version strategy](https://doc.replicache.dev/strategies/row-version) ·
[replicache.dev](https://replicache.dev/) (maintenance mode).

## Zero

**Status.** Rocicorp's successor to Replicache;
[1.0 shipped June 2026](https://www.infoq.com/news/2026/06/zero-version-1/).

**Architecture.** Three parts: client library, the `zero-cache` server, and
your own API server over upstream Postgres. zero-cache ingests Postgres
logical replication and maintains "a consistent partial replica of the
backend database to the client"; reads are ZQL queries that "initially run on
the client… any matching data is returned immediately" while zero-cache
incrementally "updates affected queries and sends row changes back."
Writes are Replicache-style custom mutators pushed to your server, which
executes the authoritative version: "the server mutator always takes
precedence… The result from the client mutator is considered speculative and
is discarded." **Offline is deliberately limited**: reads work disconnected,
but "writes are rejected" outside a brief `connecting` window — "the cost to
support offline is extremely high."

**Partial replication.** Via **synced queries**: the client's data is the
union of rows matching its active and cached queries — "You control what
syncs by writing normal queries in your app code, instead of syncing whole
tables or maintaining static sync rules." Each named query has a canonical
server implementation ("the implementations don't have to be the same");
zero-cache calls your server to resolve `(name, args)` to authoritative ZQL,
with args validated as untrusted. Deactivated queries keep syncing for a TTL
(default 5 min, max 10). Gap: the docs never crisply state when rows backing
an expired query are physically deleted from the client store.

**Permissions and revocation.** Current docs: "Zero does not have (or need) a
first-class permission system like RLS." Read permissions = server-side
rewriting of synced queries ("the server can add extra filters to enforce
permissions that the client query does not") over server-derived context;
write permissions = arbitrary checks in server mutators. (The deprecated
predecessor compiled declarative `definePermissions` rules into ZQL applied
by zero-cache to every operation.) **Revocation is undocumented in both
generations**: neither states whether already-synced rows leave a client
that loses access, nor when cached query transformations are re-evaluated
after a permission-logic change. Mechanically, data-encoded revocation
(deleting a membership row a query joins on) *should* retract rows via
incremental query maintenance — but that is inference from documented query
behavior, not a documented guarantee.

**Protocol documentation.** Not publicly documented as prose. The
client↔zero-cache wire protocol exists only as typed message schemas in
source ([`packages/zero-protocol/src`](https://github.com/rocicorp/mono/tree/main/packages/zero-protocol/src):
`connect.ts`, `change-desired-queries.ts`, `delete-clients.ts`, ZQL ASTs…)
with no stability commitment. An independent client implementation from
documentation alone is not currently feasible.

**Conflicts, ordering, migration.** Replicache-inherited rebase; no CRDTs;
ordering internals (mutation IDs, CVR versions) are code-only. On connect
"the Zero client sends a copy of the schema it was constructed with, and
zero-cache compares… rejecting the connection with a special error code if
the schema is incompatible"; recommended pattern is expand/migrate/contract
with deploy order DB → API → client. Pending-offline-write migration is moot
given offline writes are unsupported.

Sources: [permissions](https://zero.rocicorp.dev/docs/permissions) ·
[synced queries](https://zero.rocicorp.dev/docs/synced-queries) ·
[deprecated RLS permissions](https://zero.rocicorp.dev/docs/deprecated/rls-permissions) ·
[custom mutators](https://zero.rocicorp.dev/docs/custom-mutators) ·
[offline](https://zero.rocicorp.dev/docs/offline) ·
[zero-schema](https://zero.rocicorp.dev/docs/zero-schema).

## Linear's sync engine

**Source caveat.** Proprietary, zero official protocol docs. The public
record is two talks by CTO Tuomas Artman plus
[detailed reverse engineering by wzhudev](https://github.com/wzhudev/reverse-linear-sync-engine)
that Artman publicly endorsed ("a pretty awesome (and correct) write-up of
our sync engine"). Mechanics below are from that endorsed reverse
engineering — accurate per Linear's own CTO, but vendor-documented nowhere.

**Architecture.** The client materializes a full object graph (decorated
TypeScript model classes with observability), persisted per-workspace in
IndexedDB: one table per model plus `_meta` (`lastSyncId`, `firstSyncId`,
`subscribedSyncGroups`, `schemaHash`…), `__transactions` (unsent local
writes), and partial-index stores. The spine is `lastSyncId`: "a
monotonically incrementing integer representing the global database version"
— every server transaction increments it, a deliberate total order (not CRDT
partial order). Clients bootstrap (full, partial, or local-from-IndexedDB),
then apply WebSocket delta packets of sync actions, requesting missed deltas
by `firstSyncId` on reconnect. Local writes become typed transactions that
update in-memory models immediately, persist to `__transactions`, and are
sent as batched GraphQL mutations; local IndexedDB tables update only when
the confirming delta arrives, and rejection triggers rollback.

**Partial replication.** Per-model `loadStrategy` (`instant`, `lazy`,
`partial`, `explicitlyRequested`, `local`); partial models hydrate through
**partial indexes** — precomputed reachability keys (direct and up to 3
levels indirect, e.g. `Comment` by `issueId` or transitively by `teamId`) —
fetched on demand and recorded so hydration isn't repeated. The outer
boundary of what a client receives at all is its **sync groups**.

**Permissions and revocation — the key precedent.** Access control is
enforced in the sync layer via `subscribedSyncGroups` ("UUIDs that represent
your user ID, the teams you belong to, and predefined roles… you cannot
access issues or receive delta packets from workspaces or teams to which you
lack proper permissions"). Permission changes are themselves **sync actions
in the delta stream** (action types include `G`/`S` "changing sync groups"
alongside insert/update/archive/delete). On applying a delta the client
first determines "whether the user is added to or removed from sync groups";
addition triggers an inline partial bootstrap, and — verbatim from the
endorsed writeup — "if a user leaves a sync group, the models associated
with that group are also removed." That is an **active, pushed forget** over
the live WebSocket. It is the closest existing precedent to syncline's
centerpiece — and it is documented nowhere officially, at sync-group
(org/team/role) granularity rather than arbitrary row predicates.

**Protocol documentation.** None. Observable surface per reverse
engineering: ndjson bootstrap streams ending in a `_metadata_` line, GraphQL
mutations returning `lastSyncId`, WebSocket `SyncMessage` deltas, four
`/sync/*` endpoints. Rebase internals and server-side side-effect generation
remain unrecovered.

**Conflicts, ordering, migration.** "LSE employs a simple Last-Writer-Wins
strategy… specifically addressing conflicts in UpdateTransaction only" —
**per-property LWW with the server as arbiter of order** over the global
`lastSyncId` sequence. A `schemaHash` over model metadata drives local
IndexedDB migrations (`databaseVersion` counters, with
`backendDatabaseVersion` for compatibility); how pending offline
transactions survive a schema migration is not covered in any public source.

Sources: [wzhudev reverse engineering](https://github.com/wzhudev/reverse-linear-sync-engine) ·
[Scaling the Linear Sync Engine (Artman, 2023)](https://linear.app/now/scaling-the-linear-sync-engine) ·
[React Helsinki 2020 talk](https://www.youtube.com/watch?v=WxK11RsLqp4) ·
[curated materials index](https://gist.github.com/pesterhazy/3e039677f2e314cb77ffe3497ebca07b) ·
[Artman's 2022 lessons thread](https://x.com/artman/status/1558081796914483201).

## ElectricSQL

**Architecture.** Electric (post the July-2024 "electric-next" rewrite) is a
read-path-only sync engine: an Elixir service consumes Postgres logical
replication, materializes per-shape logs, and serves them to clients over
plain HTTP (`GET /v1/shape`). Clients page through a shape's log
(`offset=-1` for history, then `electric-offset`/`electric-handle` headers)
and hold long-poll requests with `live=true` (or SSE); responses carry
`cache-control`/`etag` so initial syncs and live polls can be served by CDNs
with request collapsing. **Writes never go through Electric** — "Electric
does read-path sync … Electric does not do write-path sync"; you write via
your own API, with four documented client-side patterns (online writes,
ephemeral optimistic state, shared persistent optimistic state,
through-the-database with PGlite). Offline support is whatever your client
store provides; the TypeScript client is in-memory by default, and the
durable store plus write queue are your responsibility. The 2023 product was
the opposite — bidirectional sync over a WebSocket "Satellite" protocol with
a DDLX permission-rule system and "finality of local writes" — all dropped in
the rewrite, which explicitly cited Gall's Law and reliability problems.

**Partial replication.** A shape = one root table + optional `where` clause +
optional `columns` projection + optional `queryable_columns` allow-list for
client-supplied sub-filters. Where clauses support comparison/logical
operators, `LIKE`/`ILIKE`, array operators, and `IN` with constants **or
subqueries** — subqueries enable cross-table filters ("issues where
project_id IN (select … from memberships)") with dependency tracking, so
"rows will automatically move in or out of the shape without the row itself
being modified." No include-trees/nested relations yet (roadmap #1608); shape
definitions are immutable once started (#1677); client-side narrowing params
are ANDed with the server-set clause, so subsets can only narrow.

**Permissions and revocation.** **Electric performs no authorization
itself** — shapes are HTTP resources and auth is "just HTTP," done in front
of Electric via (a) a proxy that validates credentials and sets the shape
definition server-side, or (b) the "gatekeeper" pattern (shape-scoped JWT
whose claim embeds the authorized shape; a thin proxy verifies
request-matches-claim). Revocation splits in two: token revocation fails the
*next request* with 401/403 (docs recommend short expiry) — **already-synced
data is not removed**; docs advise "on logout, perform a full page refresh to
clear synced data from memory," and durable local stores must be wiped by
your app code. Data-level removal does exist: if authorization is encoded in
the where clause (membership subquery), deleting the membership row moves
rows out of the shape and connected clients receive delete messages in the
live log. But offline clients, guaranteed purge, and revocation as a
first-class topic are not addressed.

**Protocol documentation.** The strongest of the six: a full HTTP API
reference with a downloadable OpenAPI (YAML) spec, documented log format
(`insert`/`update`/`delete` plus control messages `up-to-date`,
`must-refetch`), and a dedicated third-party client-development guide with a
working Python example (apply-atomically-at-`up-to-date` rule, offset/handle
handling). Gaps: error/backoff handling; persistence explicitly out of scope.

**Conflicts, ordering, migration.** No conflict resolution in Electric (that
died with the rewrite); write semantics are whatever your API does. The shape
log is totally ordered per shape from Postgres commit order; clients buffer
and apply atomically at `up-to-date` boundaries. Any column add/remove/rename
**invalidates the shape** — clients get `409` / `must-refetch` and fully
resync; there is no documented story for offline clients with pending writes
(pending writes live in your API's domain anyway).

Sources: [shapes guide](https://electric-sql.com/docs/guides/shapes) ·
[HTTP API](https://electric-sql.com/docs/api/http) ·
[auth guide](https://electric-sql.com/docs/guides/auth) ·
[writes guide](https://electric-sql.com/docs/guides/writes) ·
[client development](https://electric-sql.com/docs/guides/client-development) ·
[electric-next announcement](https://electric-sql.com/blog/2024/07/17/electric-next).

## PowerSync

**Architecture.** Three parts: the PowerSync Service (replicates from
Postgres WAL / MongoDB change streams / MySQL binlog and pre-partitions rows
into **buckets**), client SDKs embedding SQLite, and your own backend API.
Downstream, clients stream bucket operations and apply them only at
consistent **checkpoints**: ops stage in `ps_oplog` and copy into
`ps_data__<table>` only "when a full checkpoint has been downloaded," so the
local DB always reflects a consistent server state. Upstream, every local
mutation enters a persistent FIFO queue (`ps_crud`); the SDK calls your
`uploadData()` connector, which writes through **your backend API** to the
source database — the server is authoritative and changes flow back down via
replication. **Write checkpoints** (obtained after upload, observed back in
the stream) stop a client applying a checkpoint that doesn't yet include its
own acknowledged writes, killing revert-flicker. Clients are fully
offline-capable; local data is stored schemaless as JSON with the client
"schema" as SQLite views over it.

**Partial replication.** Server-side YAML sync rules: each bucket definition
= **parameter queries** (compute a client's bucket set from
`request.user_id()`, arbitrary JWT claims via `request.jwt()`, untrusted
client params, and replicated tables — e.g. `SELECT group_id FROM
group_memberships WHERE user_id = request.user_id()`) + **data queries**
(rows/columns per bucket, with renames/transforms). Queries are evaluated
incrementally at replication time, not as arbitrary SQL; default ≤1,000
buckets per user. Since 2025, **Sync Streams** supersede sync rules
(SQL-like queries, client-side subscriptions with parameters, a TTL keeping
data warm after unsubscribe); rules remain as legacy.

**Permissions and revocation.** Read-path authorization is enforced **inside
the sync layer** — the closest existing analogue to what syncline builds: the
service evaluates parameter queries against verified JWT claims, so a client
can only receive buckets its token derives. Write-path authorization is
entirely your backend API. Revocation: **data-driven revocation is actively
pushed** — delete the membership row and the next `checkpoint_diff` carries
`removed_buckets`; the client removes local data at checkpoint application
(prior `PUT`s "effectively converted into REMOVE operations"). No
re-subscribe needed; connected clients converge to their entitled set. But
**token revocation is unsolved** ("there is no way to revoke a JWT once
issued without rotating the key" — docs recommend ~5-minute expiry), and an
offline or expired device keeps its local SQLite until it reconnects and
receives a diff, or the app wipes the DB itself. Nothing forcibly purges an
offline device.

**Protocol documentation.** Middling. The public architecture page is a
self-described "broad overview" deferring to SDK implementations. The fuller
spec (`docs/specs/sync-protocol.md` in the powersync-service repo) defines
message types — `StreamingSyncCheckpoint`, `StreamingSyncCheckpointDiff`
(`updated_buckets`/`removed_buckets`), `StreamingSyncData`,
`StreamingSyncCheckpointComplete`, keepalive with `token_expires_in` — and
bucket op semantics (`PUT`/`REMOVE`/`MOVE`/`CLEAR`, `op_id` ordering), but
omits transport/encoding, the client's sync request format, and the checksum
algorithm; the ndjson HTTP streaming transport and `/write-checkpoint2.json`
are visible only in SDK/service code. A stranger would need to read SDK
source to build a client.

**Conflicts, ordering, migration.** Server reconciliation with **per-field
last-write-wins in server arrival order** by default ("the last update (as
received by the server) to each individual field wins"; "deletes always
win"), replaceable with custom logic in your upload endpoint (validation,
rejection, CRDT columns). Ordering: per-bucket `op_id`s + sequential
checkpoints + write checkpoints give read-your-writes. Migrations are a
documented strength: client schema is views over JSON, so most client
migrations are view redefinitions with no data rewrite; "the developer is
responsible for keeping client-side schema changes backwards-compatible."
Sync-rule redeployment recreates all buckets and forces full re-sync.
Offline clients with pending writes across a migration are not explicitly
addressed beyond the backwards-compatibility rule.

Sources: [architecture overview](https://docs.powersync.com/architecture/architecture-overview) ·
[client architecture](https://docs.powersync.com/architecture/client-architecture) ·
[parameter queries](https://docs.powersync.com/sync/rules/parameter-queries) ·
[sync protocol spec](https://github.com/powersync-ja/powersync-service/blob/main/docs/specs/sync-protocol.md) ·
[conflict handling](https://docs.powersync.com/usage/lifecycle-maintenance/handling-update-conflicts) ·
[schema changes](https://docs.powersync.com/usage/lifecycle-maintenance/implementing-schema-changes).

## Automerge (the CRDT contrast point)

**Architecture.** A library, not a service: each document is a JSON-like CRDT
carrying its full operation history as a hash-linked DAG of changes, in a
compact column-oriented binary format. There is no authoritative server —
writes commit locally on any peer and any two replicas merge
deterministically, so offline is the default mode. `automerge-repo` adds a
`Repo` managing documents with pluggable storage adapters (IndexedDB,
filesystem) and network adapters (WebSocket, MessageChannel,
BroadcastChannel); a sync server is just another peer (dumb storage/relay,
no authority). The sync protocol runs point-to-point **per document**,
exchanging heads + a Bloom filter of known changes so peers send only what's
missing.

**Partial replication.** Granularity is the **whole document**. Partiality =
model your data as many small documents and choose which IDs to sync; there
is no server-evaluated predicate, projection, or query anywhere in the
protocol. The only scoping knob, `sharePolicy`, controls *announcement*
gossip, not access: "the share policy will not stop a document being
requested by another peer by its DocumentId."

**Permissions and revocation.** **None built in** — no authn, no authz, no
encryption; a default sync-server deployment gives read/write to anyone who
can connect and name a document ID. Revocation is not addressed at all: peers
hold full history forever, there is no forget message, and deleted documents
can flow back in from peers ("a connecting peer with the default share policy
will still share that document with you"). The sanctioned future answer is
Ink & Switch's **Keyhive** (capability chains, BeeKEM group key agreement,
ciphertext sync): revocation there means key rotation so revoked members
can't decrypt *future* changes — "enforcing revocations on backdated
Automerge content" is listed as open work, and the code is pre-alpha and
unaudited. In shipped Automerge, permission-aware sync and active forget do
not exist.

**Protocol documentation.** Layered: the binary format spec rigorously
documents document/change chunk encodings and sync message formats V1/V2;
the automerge-repo WebSocket adapter ships a CBOR/CDDL protocol description
(join/peer/error handshake, request/sync/unavailable/ephemeral, gossip
messages). The sync *algorithm* (heads + Bloom negotiation, `sync::State`) is
documented conceptually rather than normatively; error recovery, timeouts,
and ephemeral semantics are vague. A stranger could implement the wire
encoding from the specs but would need the reference implementation for sync
state semantics.

**Conflicts, ordering, migration.** Merge semantics are the CRDT's:
concurrent map-key sets pick one winner "arbitrarily, but in such a way that
all nodes agree" — effectively LWW by **operation ID (Lamport counter +
actor ID), never wall-clock** — with all conflicting values retained and
inspectable (`getConflicts`). Lists/text use stable element IDs (RGA
family); ordering is causal via dependency hashes; there is no global order
and no server tiebreaker. Documents are schemaless: there is no migration
machinery and no documented story for evolving document shape across app
versions — cross-version compatibility is purely an application concern.

Sources: [merge rules](https://automerge.org/docs/reference/under-the-hood/merge-rules/) ·
[conflicts](https://automerge.org/docs/reference/documents/conflicts/) ·
[WebSocket adapter protocol](https://github.com/automerge/automerge-repo/tree/main/packages/automerge-repo-network-websocket) ·
[binary format spec](https://automerge.org/automerge-binary-format-spec/) ·
[automerge-repo sharePolicy](https://www.npmjs.com/package/@automerge/automerge-repo) ·
[Keyhive notebook](https://www.inkandswitch.com/keyhive/notebook/).

## Comparison

| System | Partial replication unit | Permission enforcement point | On revocation, synced data… | Wire protocol documented? |
|---|---|---|---|---|
| Replicache | CVR diff of an arbitrary per-user pull query (row-version strategy) | Your push/pull handlers (engine ships none) | …drops out as `del` ops on the **next pull** — passive, undiscussed, no guarantee stated | Server side: yes, near-normative. Client side: conceptual only |
| Zero | Union of synced queries, server-rewritten per user | Server-side query rewriting + server mutators ("no first-class permission system") | …**undocumented** in both permission generations; data-encoded retraction is inference, not a guarantee | No — typed schemas in source only, no stability commitment |
| Linear | Sync groups (org/team/role) + per-model load strategies + partial indexes | Sync layer (`subscribedSyncGroups` gates delta packets) | …is **actively deleted, pushed live** over WebSocket ("models associated with that group are also removed") | No — proprietary; known only via endorsed reverse engineering |
| ElectricSQL | Shapes (table + where + columns, subqueries) | None in Electric — your proxy/gatekeeper in front | …stays on device for token revocation ("full page refresh" advice); where-clause row exits push deletes to *connected* clients only | Yes — OpenAPI spec + third-party client guide (best of the six) |
| PowerSync | Buckets from parameter queries over JWT claims + replicated tables | **Inside the sync service** (parameter queries over verified claims) | …is removed at next checkpoint via `removed_buckets` — active for connected clients; offline devices never purged; JWT revocation unsolved (short expiry only) | Partial — message types spec'd, transport/encoding/request format not |
| Automerge | Whole documents (choose which IDs to sync) | None (sharePolicy is gossip control, "will not stop a document being requested") | …stays forever (full history on every peer); Keyhive's future answer is key rotation, which can't un-share plaintext | Byte-level formats yes; sync-state semantics need the reference impl |

Three cross-cutting facts fall out:

1. **Nobody documents revocation.** The two systems that *have* an active
   removal path (Linear, PowerSync) either don't document it at all (Linear —
   reverse engineering only) or leave offline devices and token revocation
   explicitly unsolved (PowerSync). Replicache's removal is passive;
   Zero's is unstated; Electric's advice is "refresh the page"; Automerge
   cannot remove anything by construction.
2. **Protocol documentation is a spectrum, and nobody covers permissions in
   it.** Electric documents its read protocol excellently — but permissions
   live outside it by design. Replicache documents push/pull normatively —
   for the server you write yourself. No system publishes a protocol spec in
   which permission semantics, entitlement change, and data removal are
   first-class messages a stranger could implement.
3. **The authoritative-server + optimistic-rebase family won.** Replicache,
   Zero, Linear, and PowerSync all converge on server-assigned ordering with
   client-side optimistic apply and rebase/LWW — none use CRDTs for domain
   data, and the Linear writeup explicitly argues CRDTs fit poorly with
   partial sync and permission control. Automerge is the counterexample that
   proves the rule: full-history CRDTs and revocation are structurally at
   odds.

## The gap syncline fills

**Permission-aware partial replication as the centerpiece of a documented
protocol.** Concretely, syncline commits to the three things no surveyed
system delivers together:

1. **Permissions evaluated in the sync layer itself, on every outbound
   op** — PowerSync-style entitlement computation (the only surveyed system
   that does this) but as a first-class, specified part of the protocol
   rather than service configuration, with a single evaluation function
   shared by server, client, and test harness so a bypass path is
   structurally visible.
2. **Active forget on revocation, specified and tested** — Linear-style
   pushed removal (the only surveyed precedent, and it's unofficial) promoted
   to an explicit, idempotent, acknowledged `forget` protocol message,
   distinct from delete tombstones (deletes are data every permitted client
   learns; forgets are per-principal instructions), delivered live to
   connected clients and forced at next handshake for offline ones — with
   the offline-device limitation stated honestly instead of ignored: a
   device that never reconnects can never be made to forget, and no surveyed
   system solves that either (Keyhive's key rotation comes closest and still
   can't un-share plaintext).
3. **A protocol document a stranger could implement** — Electric-grade wire
   documentation (the only surveyed system that reaches it) but covering the
   full loop Electric deliberately excludes: writes, idempotent push,
   per-subscription cursors, entitlement epochs, forget, per-field LWW
   keyed on server order, and schema version negotiation for stale clients
   with pending writes (a scenario every surveyed system leaves undocumented
   or unsupported — Zero rejects offline writes outright, Replicache says
   "keep old mutators callable," PowerSync says "stay backwards-compatible,"
   Linear's story is unknown).

The design contrast to defend in docs/writeup.md: syncline accepts
server-authoritative per-field LWW (the choice Linear and PowerSync validate
at scale) and spends the complexity budget the CRDT systems spend on merge
semantics on **entitlement semantics** instead — because for multi-tenant
collaborative tools, "who is allowed to hold this data" is the harder and
less-served problem than "how do concurrent edits merge."
