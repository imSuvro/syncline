# syncline demo — UX specification

The demo app has one job: **make the sync engine visible**. It is a team
issue tracker only because issues + workspaces + roles are the smallest
domain where partial replication and revocation are legible to a viewer in
under a minute. Every design choice below serves that job. High-fidelity
mockups: `docs/design/mockups.html` (also published as a Claude artifact).

## Design direction — "instrument panel"

The tracker itself is calm, paper-toned, and unremarkable on purpose: obvious
controls, sensible defaults, zero learning curve. The personality lives in
the **engine's voice**: everything the sync layer says — connection state,
seq numbers, pending counts, op traffic, forget instructions — renders in
monospace telemetry, visually distinct from product UI. Two voices, one
screen: *the app you use* (humanist sans, quiet) and *the machine narrating
what it's doing underneath* (mono, precise).

- Type: **Instrument Sans** for product UI · **IBM Plex Mono** for
  everything the engine says · Instrument Serif only for the landing
  headline. (Google Fonts, with system fallbacks.)
- Palette (light): paper `#F7F7F4`, surface `#FFFFFF`, ink `#16181D`, muted
  `#667085`, wire-blue accent `#2447F0` (sync activity), live `#0B8A5C`,
  pending amber `#B45309`, forget red `#C2331F`. Dark mode mirrors the same
  tokens on graphite (`#101216` paper, `#171A20` surface).
- **Signature element: the sync ticker** — a thin strip docked at the bottom
  of the workspace, streaming the live op feed (`▲ push` outgoing, `▼ op`
  incoming, each with its server seq). It is the oscilloscope trace of the
  whole demo: you *watch* server-assigned ordering happen, and during the
  showcase you see the `forget` instruction arrive one beat before the data
  dissolves. Collapsed it is 28px of quiet telemetry; expanded it shows the
  last ~50 frames. One bold element; everything else stays disciplined.

## Cast and seed data (fixed, pre-seeded — no signup wall)

| User | Color | Acme Launch | Skunkworks |
|---|---|---|---|
| Priya | indigo | **owner** | — |
| Maya | teal | editor | editor |
| Theo | amber | viewer | **owner** |
| Sam | rose | *(not a member — the invite target)* | editor |

Two workspaces so partial replication is visible from the first click:
Priya's sidebar shows one workspace, Maya's shows two — different people,
different replicas. ~40 issues split across both (realistic titles, varied
status/priority/assignee).

## Flows

### 1. Landing — "log in as"

Four person cards (name, color token, role summary per workspace) + a short
demo script ("Try this: open two browsers…"). Clicking a card enters the app
as that person; a header switcher allows changing later. Below the cards:
**"Open a second user in incognito"** — copies the URL and shows the
keyboard shortcut for an incognito window in a toast ("Link copied — press
Ctrl+Shift+N and paste"). No passwords, no signup, nothing to learn.

### 2. Workspace shell

Left sidebar: workspace list (only replicated ones), member panel, the
signed-in identity. Main: issue list grouped by status. Top right: the
**connection pill**. Bottom: the sync ticker. Mobile (<720px): single
column; members and ticker become sheets; the pill stays visible.

### 3. Issues — where LWW is felt

Issue rows edit inline: title (text), status / priority / assignee
(select menus). No modals for editing — the point is concurrent field edits.
When a field changes underneath you (another user's op applies), it flashes
a brief wire-blue highlight with attribution: `status ▸ Done · Maya, just
now`. Scripted demo beat: two browsers edit *different* fields of the same
issue → both stick (per-field LWW merges perfectly); then both edit the
*same* field → last server order wins, the loser sees the flash +
attribution, nothing is hidden or apologized for. Create = one input at the
top of the list ("New issue…" → Enter). Empty state: "No issues yet — type
above to create the first."

### 4. Connection pill + pending badge

One element, three states, always visible:

- `● live` (green dot, mono label) — connected, cursor current.
- `◐ syncing · 3 pending` (amber) — connected, outbox draining or backfill
  catching up. The pending count IS the outbox length; it ticks down
  visibly as acks arrive.
- `○ offline · 5 saved locally` (slate, plus a one-line banner under the
  header: "Offline — changes are saved on this device and will sync when
  you're back.") — no red, no alarm; offline is a supported state, and the
  copy says so.

The pill contains the demo's honest cheat: a **"Simulate offline"** toggle
(demo-only, clearly labeled), so a viewer can run the offline→edit→reconnect
→converge script without touching DevTools. Reconnect plays the pill through
`syncing · n pending` → `live`, and the ticker visibly replays the queued
pushes then the backfill.

### 5. Presence

Small presence dots (user-color, mono initials) in the workspace header for
members currently connected; join/leave fades over 200ms. Presence is
ephemeral engine state — it renders in the telemetry voice, not as product
chrome.

### 6. Members panel — invite and revoke

Owners see `Invite` (pick from seeded users not yet members, choose role)
and `Revoke` per member; editors/viewers see the list read-only (server
enforces regardless — UI visibility is a courtesy, never the control).
Revoke confirms with honest language that teaches the feature:

> Revoke Maya's access to Acme Launch?
> Her devices will be instructed to forget this workspace's data.
> [Cancel] [Revoke access]

### 7. The showcase — revocation, from the revoked side

The choreography (each beat visible, total ~2s, reduced-motion collapses to
instant):

1. Ticker prints the arrival in forget-red: `▼ forget workspace=acme
   upToSeq=1042`.
2. Issue rows dissolve — a 400ms per-row fade/collapse cascade (top to
   bottom), the visual of data *leaving the device*, not a page navigation.
3. The workspace collapses to a single card: **"You were removed from Acme
   Launch. This device has forgotten the workspace's data."** — mono
   sub-line: `store purged · outbox cleared · cursor reset`. A "Back to your
   workspaces" button. The workspace vanishes from the sidebar.
4. If re-invited: workspace reappears in the sidebar with a
   `bootstrapping · n ops` progress line in the ticker, then opens fresh
   (snapshot, new epoch — never stale resurrection).

The revoking side sees the member row leave the panel and presence dot drop.

### 8. Schema-version beat (stage 12 surfaces it)

If the server announces a newer schema at handshake, the pill shows
`◐ upgrading · migrating n queued changes`, then resumes — the stale-client-
with-pending-writes story rendered in one line of telemetry.

## View-model contract (what `@syncline/client` must expose to the UI)

The UI consumes reactive state only — no imperative store access:

- `useConnection(): { state: 'live'|'syncing'|'offline'; pending: number }`
- `useWorkspaces(): WorkspaceSummary[]` (replicated ones only)
- `useQuery(q): rows` — reactive issue queries (by workspace, grouped)
- `usePresence(workspaceId): Member[]`
- `useMembers(workspaceId): { member, role }[]` + `invite() / revoke()`
  mutators (permission-checked server-side)
- `useMembershipEvents(): { removed: { workspaceId, name } }` — feeds beat 3
- `useSyncFeed(limit): Frame[]` — the ticker (demo-facing, read-only)
- Demo-only: `setSimulatedOffline(bool)`

## Quality floor

Keyboard operable end-to-end (issue creation, inline edits, member actions);
visible focus rings (wire-blue); `prefers-reduced-motion` respected (all
choreography becomes instant state changes); mobile responsive; all copy in
sentence case, active voice, no filler; every state (empty, offline,
removed, upgrading) designed rather than accidental.
