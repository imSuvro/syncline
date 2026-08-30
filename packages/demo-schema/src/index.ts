// syncline-demo-schema — the issue tracker's tables, permission ruleset,
// schema version, and seed data (backlog B4; ruleset per ADR-003; cast and
// data per docs/ux.md). Stage 12 adds v2 + the migrator chain (F2).
import type { FieldValue, Op, RowState, Ruleset } from '@syncline/protocol';

/**
 * Schema versions (ADR-006). v2 renames `issues.priority` to
 * `issues.severity` and normalizes its middle value (`med` → `medium`) —
 * a deliberately real migration: it changes a field name, so op payloads
 * written by a v1 client cannot be applied as-is and must be rewritten.
 * The server accepts ops in [MIN_WRITABLE_VERSION, DEMO_SCHEMA_VERSION].
 */
export const DEMO_SCHEMA_VERSION = 2;
export const MIN_WRITABLE_VERSION = 1;

/**
 * Tables:
 * - issues:      title, status (todo|in_progress|in_review|done),
 *                priority (low|med|high), assignee (userId or null)
 * - memberships: userId, role — one row per member, rowId = userId.
 *   Membership rows ARE the entitlement data: the server's sync path reacts
 *   to ops on this table (epoch bumps, forget) per ADR-004.
 */
// --- Migration chain (ADR-006) ---------------------------------------------
// Both migrators are TOTAL: every input maps to a valid output. Dropping an
// op is not expressible — the return type is `Op`, not `Op | null` — which
// is what makes "no acknowledged write is ever lost across a migration" a
// property of the types rather than a promise in a comment.

const V1_TO_V2_SEVERITY: Record<string, FieldValue> = {
  low: 'low',
  med: 'medium',
  high: 'high',
};

const severityValue = (v: FieldValue): FieldValue =>
  typeof v === 'string' ? (V1_TO_V2_SEVERITY[v] ?? v) : v;

const v1ToV2Op = (op: Op): Op => {
  if (op.table !== 'issues') return op;
  switch (op.kind) {
    case 'create': {
      const { priority, ...rest } = op.fields;
      return priority === undefined
        ? op
        : { ...op, fields: { ...rest, severity: severityValue(priority) } };
    }
    case 'update':
      return op.field === 'priority'
        ? { ...op, field: 'severity', value: severityValue(op.value) }
        : op;
    case 'delete':
      return op;
  }
};

/** Migrate one op payload up to the current version. Identity — the
 * (clientId, opId) pair — is never touched (ADR-002/006). */
export const migrateOp = (op: Op, fromVersion: number): Op =>
  fromVersion < 2 ? v1ToV2Op(op) : op;

/** Migrate locally stored rows up to the current version (client side). */
export const migrateRows = (rows: RowState[], fromVersion: number): RowState[] => {
  if (fromVersion >= 2) return rows;
  return rows.map((row) => {
    if (row.table !== 'issues') return row;
    const { priority, ...rest } = row.fields;
    if (priority === undefined) return row;
    return {
      ...row,
      fields: { ...rest, severity: { v: severityValue(priority.v), seq: priority.seq } },
    };
  });
};

export const DEMO_RULESET: Ruleset = {
  version: DEMO_SCHEMA_VERSION,
  tables: {
    issues: {
      read: { kind: 'member' },
      write: { kind: 'role', atLeast: 'editor' },
      create: { kind: 'role', atLeast: 'editor' },
      delete: { kind: 'role', atLeast: 'editor' },
    },
    memberships: {
      read: { kind: 'member' },
      write: { kind: 'role', atLeast: 'owner' }, // role changes: owner only
      create: { kind: 'role', atLeast: 'owner' }, // invite: owner only
      // revoke: owner, or yourself (leave workspace)
      delete: { kind: 'any', of: [{ kind: 'role', atLeast: 'owner' }, { kind: 'self', field: 'userId' }] },
    },
  },
};

// --- Cast (docs/ux.md) ------------------------------------------------------

export interface DemoUser {
  userId: string;
  name: string;
  color: string;
}

export const DEMO_USERS: DemoUser[] = [
  { userId: 'priya', name: 'Priya', color: '#4F46E5' },
  { userId: 'maya', name: 'Maya', color: '#0D9488' },
  { userId: 'theo', name: 'Theo', color: '#D97706' },
  { userId: 'sam', name: 'Sam', color: '#E11D48' },
];

export interface DemoWorkspace {
  workspaceId: string;
  name: string;
  members: { userId: string; role: 'owner' | 'editor' | 'viewer' }[];
}

export const DEMO_WORKSPACES: DemoWorkspace[] = [
  {
    workspaceId: 'acme',
    name: 'Acme Launch',
    members: [
      { userId: 'priya', role: 'owner' },
      { userId: 'maya', role: 'editor' },
      { userId: 'theo', role: 'viewer' },
      // sam is deliberately absent: the invite target of the showcase
    ],
  },
  {
    workspaceId: 'skunk',
    name: 'Skunkworks',
    members: [
      { userId: 'theo', role: 'owner' },
      { userId: 'maya', role: 'editor' },
      { userId: 'sam', role: 'editor' },
    ],
  },
];

// --- Seed ops ---------------------------------------------------------------
// Seeds flow through the normal op pipeline at workspace creation (a system
// client pushes them), so they get real seqs and exercise the same code as
// user writes.

const issue = (
  workspaceId: string,
  n: number,
  title: string,
  status: FieldValue,
  severity: FieldValue,
  assignee: FieldValue,
): Op => ({
  kind: 'create',
  table: 'issues',
  rowId: `${workspaceId}-${String(n)}`,
  // Seeds are written at the current version (v2): `severity`, not the v1
  // `priority`. A v1 client's ops are migrated on arrival.
  fields: { title, status, severity: severityValue(severity), assignee },
});

// Membership rows are keyed by a minted per-episode rowId, NOT by userId:
// revoke tombstones the episode and re-invite creates a fresh row, so the
// ADR-005 "rowIds never resurrect" rule and re-invite coexist. userId lives
// in the fields (the `self` predicate and the server's live-role lookup
// both read it there).
const membership = (userId: string, role: string): Op => ({
  kind: 'create',
  table: 'memberships',
  rowId: `mem-${userId}-1`,
  fields: { userId, role },
});

const ACME_TITLES: [string, string, string, string | null][] = [
  ['Wire up billing webhooks', 'done', 'high', 'priya'],
  ['Landing page copy pass', 'in_progress', 'med', 'maya'],
  ['Rotate API keys before launch', 'todo', 'low', 'theo'],
  ['Design pricing table', 'in_review', 'med', 'maya'],
  ['Fix OAuth redirect loop', 'in_progress', 'high', 'priya'],
  ['Draft launch tweet thread', 'todo', 'med', 'maya'],
  ['Set up status page', 'todo', 'low', null],
  ['Audit bundle size', 'in_review', 'med', 'priya'],
  ['Write onboarding emails', 'in_progress', 'med', 'maya'],
  ['QA pass on mobile Safari', 'todo', 'high', 'theo'],
  ['Migrate DNS to new registrar', 'done', 'high', 'priya'],
  ['Add rate limiting to API', 'in_progress', 'high', 'priya'],
  ['Customer interview notes writeup', 'done', 'low', 'theo'],
  ['Press kit assets', 'todo', 'med', 'maya'],
  ['Update ToS and privacy policy', 'in_review', 'high', 'priya'],
  ['Instrument signup funnel', 'todo', 'med', null],
  ['Fix dark-mode logo contrast', 'done', 'low', 'maya'],
  ['Load test checkout flow', 'todo', 'high', 'priya'],
  ['Localize date formats', 'todo', 'low', null],
  ['Archive stale feature flags', 'in_progress', 'low', 'theo'],
  ['Launch-day runbook', 'in_review', 'high', 'priya'],
  ['Refresh screenshots in docs', 'todo', 'med', 'maya'],
];

const SKUNK_TITLES: [string, string, string, string | null][] = [
  ['Prototype voice input', 'in_progress', 'high', 'sam'],
  ['Evaluate WASM build of parser', 'todo', 'med', 'theo'],
  ['Spike: offline map tiles', 'in_review', 'med', 'sam'],
  ['Bench columnar cache layout', 'done', 'high', 'theo'],
  ['Sketch plugin API surface', 'todo', 'med', 'maya'],
  ['Try SIMD text search', 'in_progress', 'high', 'sam'],
  ['Fuzz the import pipeline', 'todo', 'high', 'theo'],
  ['Draft RFC: sync groups', 'in_review', 'med', 'maya'],
  ['Port renderer to OffscreenCanvas', 'todo', 'low', null],
  ['Measure cold-start on low-end Android', 'done', 'med', 'sam'],
  ['Explore CRDT text for comments', 'todo', 'low', 'maya'],
  ['Secret demo for all-hands', 'in_progress', 'high', 'theo'],
  ['Kill the flaky e2e suite', 'todo', 'high', 'sam'],
  ['Investigate battery drain report', 'in_review', 'med', 'theo'],
  ['Zero-copy JSON scanner', 'todo', 'med', null],
  ['Write up spike learnings', 'todo', 'low', 'maya'],
  ['Threat-model the plugin sandbox', 'in_progress', 'high', 'theo'],
  ['Trace long GC pauses', 'todo', 'med', 'sam'],
];

/** Seed ops per workspace, in push order: memberships first, then issues. */
export const seedOps = (workspaceId: string): Op[] => {
  const ws = DEMO_WORKSPACES.find((w) => w.workspaceId === workspaceId);
  if (ws === undefined) return [];
  const titles = workspaceId === 'acme' ? ACME_TITLES : SKUNK_TITLES;
  return [
    ...ws.members.map((m) => membership(m.userId, m.role)),
    ...titles.map(([title, status, priority, assignee], i) =>
      issue(workspaceId, i + 1, title, status, priority, assignee),
    ),
  ];
};

/** The system principal that pushes seeds at workspace creation. */
export const SEED_CLIENT_ID = 'system-seed';
