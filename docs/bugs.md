# Bugs found by the verification stack

Kept because the bugs a project's own tests catch say more about the tests
than a passing suite does. Each entry names what found it.

| # | Found by | Bug | Why it mattered |
|---|---|---|---|
| 1 | stage-8 unit tests | Membership rows keyed by `userId` made re-invite impossible: the revoke tombstone swallowed the new membership row, because ADR-005 says row ids never resurrect. | Re-invite silently did nothing. Fixed by keying membership rows per *episode* (`mem-<user>-<n>`); recorded as an amendment in ADR-004. |
| 2 | stage-9 determinism test | The fake transport gave every frame an independent random delay, so frames could arrive out of order within one connection — which WebSockets never do. | The harness was testing a network that does not exist, and the resulting "convergence failure" was the model's fault, not the engine's. Transport is now FIFO per direction. |
| 3 | stage-10 client tests | `lastSentOpId` persisted across sessions, so a reconnect that took the snapshot path never re-sent the outbox. | An acknowledged-write loss path — the exact class of bug invariant (c) exists to prevent. Fixed by resetting it on every `helloAck`. |
| 4 | stage-10 client tests | The optimistic overlay dropped updates to rows absent from `base`. | An author's own offline edit disappeared from their screen after a purge. The overlay now synthesizes the row. |
| 5 | stage-13 browser session | The React binding memoized engine snapshots against a referentially stable setter, so `pending` froze at its first value. | The pending badge never moved — the UI lied about durable state. Found only by driving the real app. |
| 6 | stage-13 browser session | A rejected storage batch left the effect chain rejected, so every later step was skipped in silence. | The client would look alive and accept nothing, forever. Now caught and surfaced as an event. |
| 7 | stage-13 browser session | Storage batches raced instead of queueing. | A snapshot's `clearAll` could overtake the rows written after it, corrupting the local store. Batches now queue in emission order. |
| 8 | **fuzz seeds 66 and 377** | A frame in flight from a previous socket rewound the cursor, because `advanceTo` was assigned unconditionally. | Every op between the stale mark and the client's true position was stranded — silent, permanent divergence. Cursors are now monotonic within an epoch, in both the engine and the reference client. (The seeds also exposed an unrealistic harness model: two live sockets for one device.) |

Reproduce any fuzz finding exactly:

```bash
pnpm fuzz --seed 66
```
