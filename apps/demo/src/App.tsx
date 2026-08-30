// The demo issue tracker (docs/ux.md, docs/design/mockups.html). Its job is
// to make the engine visible: the connection pill, the pending badge, the
// presence dots, the sync ticker, and above all the revoke moment.
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import type { Op } from '@syncline/protocol';
import type { ViewRow } from '@syncline/client';
import { DEMO_USERS, DEMO_WORKSPACES } from 'syncline-demo-schema';
import { fetchDirectory, login, type DemoUser, type WorkspaceSummary } from './api.js';
import { useFlash, useSync } from './useSync.js';

const STATUSES = ['todo', 'in_progress', 'in_review', 'done'] as const;
const SEVERITIES = ['low', 'medium', 'high'] as const;
const STATUS_LABEL: Record<string, string> = {
  todo: 'Todo',
  in_progress: 'In progress',
  in_review: 'In review',
  done: 'Done',
};

const userById = (userId: string): DemoUser | undefined =>
  DEMO_USERS.find((u) => u.userId === userId);

const initials = (userId: string): string => (userById(userId)?.name ?? userId).slice(0, 1);

export const App = (): ReactElement => {
  const [session, setSession] = useState<{ token: string; user: DemoUser } | null>(null);
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [activeWs, setActiveWs] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshDirectory = useCallback(
    async (token: string) => {
      const list = await fetchDirectory(token);
      setWorkspaces(list);
      setActiveWs((current) =>
        current !== null && list.some((w) => w.workspaceId === current)
          ? current
          : (list[0]?.workspaceId ?? null),
      );
    },
    [],
  );

  const signIn = async (userId: string): Promise<void> => {
    try {
      const result = await login(userId);
      setSession(result);
      await refreshDirectory(result.token);
    } catch {
      setError('Could not reach the sync server. Is it running?');
    }
  };

  if (session === null) {
    return <Landing onPick={(id) => void signIn(id)} error={error} />;
  }
  return (
    <Workspace
      key={`${session.user.userId}:${activeWs ?? 'none'}`}
      session={session}
      workspaces={workspaces}
      activeWs={activeWs}
      onSelect={setActiveWs}
      onSignOut={() => {
        setSession(null);
        setWorkspaces([]);
        setActiveWs(null);
      }}
      onDirectoryChange={() => void refreshDirectory(session.token)}
    />
  );
};

// --- landing ---------------------------------------------------------------

const Landing = ({
  onPick,
  error,
}: {
  onPick: (userId: string) => void;
  error: string | null;
}): ReactElement => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="landing">
      <h1>Syncline</h1>
      <p className="lede">
        A local-first issue tracker that shows you its sync engine. Pick a person to begin — no
        signup, no passwords.
      </p>
      {error !== null && <div className="banner">{error}</div>}
      <div className="people">
        {DEMO_USERS.map((user) => {
          const roles = DEMO_WORKSPACES.filter((w) =>
            w.members.some((m) => m.userId === user.userId),
          ).map((w) => `${w.workspaceId} · ${w.members.find((m) => m.userId === user.userId)?.role ?? ''}`);
          return (
            <button key={user.userId} className="person" onClick={() => { onPick(user.userId); }}>
              <div className="avatar" style={{ background: user.color }}>
                {user.name.slice(0, 1)}
              </div>
              <div className="name">{user.name}</div>
              <div className="roles">
                {roles.length === 0 ? 'no workspaces yet' : roles.map((r) => <div key={r}>{r}</div>)}
              </div>
            </button>
          );
        })}
      </div>
      <button
        className="incognito"
        onClick={() => {
          void navigator.clipboard.writeText(window.location.href);
          setCopied(true);
          setTimeout(() => { setCopied(false); }, 2400);
        }}
      >
        {copied ? 'Link copied — press Ctrl+Shift+N and paste' : 'Open a second user in incognito'}
      </button>
      <div className="script">
        <h2>Try this</h2>
        <ol>
          <li>Sign in as Priya here, and as Maya in an incognito window.</li>
          <li>Edit different fields of the same issue in both — watch them merge.</li>
          <li>Switch Maya offline, edit, then reconnect — the queue drains and converges.</li>
          <li>As Priya, revoke Maya from Acme Launch. Watch her data vanish.</li>
        </ol>
      </div>
    </div>
  );
};

// --- workspace -------------------------------------------------------------

interface WorkspaceProps {
  session: { token: string; user: DemoUser };
  workspaces: WorkspaceSummary[];
  activeWs: string | null;
  onSelect: (id: string) => void;
  onSignOut: () => void;
  onDirectoryChange: () => void;
}

const Workspace = ({
  session,
  workspaces,
  activeWs,
  onSelect,
  onSignOut,
  onDirectoryChange,
}: WorkspaceProps): ReactElement => {
  const sync = useSync(session.token, session.user.userId, activeWs ?? 'none');
  const [confirmRevoke, setConfirmRevoke] = useState<{ rowId: string; name: string } | null>(null);
  const [offline, setOffline] = useState(false);
  const [newTitle, setNewTitle] = useState('');

  const issues = sync?.rows('issues') ?? [];
  const members = sync?.rows('memberships') ?? [];
  const myRole = members.find((m) => m.values['userId'] === session.user.userId)?.values['role'];
  const canEdit = myRole === 'owner' || myRole === 'editor';
  const isOwner = myRole === 'owner';

  // Deliberately NOT auto-navigating on removal: the whole point of this
  // app is that you get to watch your data leave. The sidebar refreshes
  // when the reader dismisses the card.

  if (activeWs === null) {
    return (
      <div className="landing">
        <h1>No workspaces</h1>
        <p className="lede">You are not a member of any workspace right now.</p>
        <button className="btn" onClick={onSignOut}>Back to sign in</button>
      </div>
    );
  }

  const mutate = (op: Op): void => { sync?.mutate(op); };

  const createIssue = (): void => {
    const title = newTitle.trim();
    if (title === '' || !canEdit) return;
    mutate({
      kind: 'create',
      table: 'issues',
      rowId: `${activeWs}-${crypto.randomUUID().slice(0, 8)}`,
      fields: { title, status: 'todo', severity: 'medium', assignee: session.user.userId },
    });
    setNewTitle('');
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div>
          <h3>WORKSPACES</h3>
          {workspaces.map((w) => (
            <button
              key={w.workspaceId}
              className={`ws-item${w.workspaceId === activeWs ? ' active' : ''}`}
              onClick={() => { onSelect(w.workspaceId); }}
            >
              {w.name}
            </button>
          ))}
        </div>
        <div>
          <h3>MEMBERS</h3>
          {members.map((m) => {
            const userId = String(m.values['userId'] ?? '');
            const online = sync?.presence.includes(userId) ?? false;
            return (
              <div key={m.rowId} className="member">
                <span className={`pdot${online ? ' on' : ''}`} />
                {userById(userId)?.name ?? userId}
                <span className="role">{String(m.values['role'] ?? '')}</span>
                {isOwner && userId !== session.user.userId && (
                  <button
                    className="revoke-btn"
                    onClick={() => {
                      setConfirmRevoke({ rowId: m.rowId, name: userById(userId)?.name ?? userId });
                    }}
                  >
                    Revoke
                  </button>
                )}
              </div>
            );
          })}
          {isOwner && <InvitePanel members={members} onInvite={mutate} />}
        </div>
        <div className="identity">
          <span className="avatar" style={{ background: session.user.color, width: 22, height: 22, fontSize: 11, margin: 0 }}>
            {session.user.name.slice(0, 1)}
          </span>
          {session.user.name}
          <button className="link-btn" onClick={onSignOut}>Switch</button>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <h2>{workspaces.find((w) => w.workspaceId === activeWs)?.name ?? activeWs}</h2>
          <div className="presence">
            {(sync?.presence ?? []).map((userId) => (
              <span key={userId} title={userById(userId)?.name ?? userId} style={{ background: userById(userId)?.color ?? '#888' }}>
                {initials(userId)}
              </span>
            ))}
          </div>
          <ConnectionPill
            phase={sync?.phase ?? 'booting'}
            pending={sync?.pending ?? 0}
            offline={offline}
            onToggleOffline={() => {
              const next = !offline;
              setOffline(next);
              sync?.setSimulatedOffline(next);
            }}
          />
        </div>

        {sync?.removed === true ? (
          <RemovedCard
            workspaceName={workspaces.find((w) => w.workspaceId === activeWs)?.name ?? activeWs}
            onBack={onDirectoryChange}
          />
        ) : (
          <>
            {(sync?.phase === 'offline' || offline) && (
              <div className="banner">
                Offline — changes are saved on this device and will sync when you&apos;re back.
              </div>
            )}
            {canEdit && (
              <input
                className="new-issue"
                placeholder="New issue…"
                value={newTitle}
                onChange={(e) => { setNewTitle(e.target.value); }}
                onKeyDown={(e) => { if (e.key === 'Enter') createIssue(); }}
              />
            )}
            <IssueList issues={issues} canEdit={canEdit} onMutate={mutate} />
          </>
        )}

        <Ticker feed={sync?.feed ?? []} />
      </main>

      {confirmRevoke !== null && (
        <ConfirmRevoke
          name={confirmRevoke.name}
          workspaceName={workspaces.find((w) => w.workspaceId === activeWs)?.name ?? activeWs}
          onCancel={() => { setConfirmRevoke(null); }}
          onConfirm={() => {
            mutate({ kind: 'delete', table: 'memberships', rowId: confirmRevoke.rowId });
            setConfirmRevoke(null);
          }}
        />
      )}
    </div>
  );
};

// --- pieces ----------------------------------------------------------------

const ConnectionPill = ({
  phase,
  pending,
  offline,
  onToggleOffline,
}: {
  phase: string;
  pending: number;
  offline: boolean;
  onToggleOffline: () => void;
}): ReactElement => {
  const [color, label] =
    phase === 'offline' || offline
      ? ['var(--slate)', `offline · ${String(pending)} saved locally`]
      : pending > 0 || phase === 'connecting'
        ? ['var(--amber)', pending > 0 ? `syncing · ${String(pending)} pending` : 'connecting']
        : phase === 'revoked'
          ? ['var(--forget)', 'removed']
          : ['var(--live)', 'live'];
  return (
    <span className="pill">
      <span className="dot" style={{ background: color }} />
      {label}
      <button onClick={onToggleOffline}>{offline ? 'go online' : 'simulate offline'}</button>
    </span>
  );
};

const IssueList = ({
  issues,
  canEdit,
  onMutate,
}: {
  issues: ViewRow[];
  canEdit: boolean;
  onMutate: (op: Op) => void;
}): ReactElement => {
  const [isFlashing, flash] = useFlash();
  const seen = useMemo(() => new Map<string, string>(), []);

  // Flash any field whose value changed since the last render (someone
  // else's op landing, or our own ack) — docs/ux.md attribution beat.
  useEffect(() => {
    for (const issue of issues) {
      for (const [field, value] of Object.entries(issue.values)) {
        const key = `${issue.rowId}.${field}`;
        const prev = seen.get(key);
        if (prev !== undefined && prev !== String(value)) flash(key);
        seen.set(key, String(value));
      }
    }
  }, [issues, flash, seen]);

  if (issues.length === 0) {
    return <div className="empty">No issues yet — type above to create the first.</div>;
  }

  const grouped = STATUSES.map((status) => ({
    status,
    rows: issues.filter((i) => i.values['status'] === status),
  })).filter((g) => g.rows.length > 0);

  return (
    <>
      {grouped.map(({ status, rows }) => (
        <section key={status}>
          <div className="group-label">
            {STATUS_LABEL[status]?.toUpperCase()} · {rows.length}
          </div>
          {rows.map((issue) => (
            <div key={issue.rowId} className={`issue${issue.pending ? ' pending' : ''}`}>
              <span className="id mono">{issue.rowId.slice(-6)}</span>
              <input
                className="title"
                defaultValue={String(issue.values['title'] ?? '')}
                disabled={!canEdit}
                onBlur={(e) => {
                  if (e.target.value !== issue.values['title']) {
                    onMutate({ kind: 'update', table: 'issues', rowId: issue.rowId, field: 'title', value: e.target.value });
                  }
                }}
              />
              {issue.pending && <span className="attribution">pending</span>}
              <select
                className={isFlashing(`${issue.rowId}.status`) ? 'flash' : ''}
                value={String(issue.values['status'] ?? 'todo')}
                disabled={!canEdit}
                onChange={(e) => {
                  onMutate({ kind: 'update', table: 'issues', rowId: issue.rowId, field: 'status', value: e.target.value });
                }}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>{STATUS_LABEL[s]}</option>
                ))}
              </select>
              <select
                className={isFlashing(`${issue.rowId}.severity`) ? 'flash' : ''}
                value={String(issue.values['severity'] ?? 'medium')}
                disabled={!canEdit}
                onChange={(e) => {
                  onMutate({ kind: 'update', table: 'issues', rowId: issue.rowId, field: 'severity', value: e.target.value });
                }}
              >
                {SEVERITIES.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              {typeof issue.values['assignee'] === 'string' && (
                <span
                  className="avatar"
                  style={{ background: userById(issue.values['assignee'])?.color ?? '#888', width: 20, height: 20, fontSize: 9, margin: 0 }}
                  title={userById(issue.values['assignee'])?.name}
                >
                  {initials(issue.values['assignee'])}
                </span>
              )}
            </div>
          ))}
        </section>
      ))}
    </>
  );
};

const InvitePanel = ({
  members,
  onInvite,
}: {
  members: ViewRow[];
  onInvite: (op: Op) => void;
}): ReactElement | null => {
  const current = new Set(members.map((m) => String(m.values['userId'])));
  const candidates = DEMO_USERS.filter((u) => !current.has(u.userId));
  const [pick, setPick] = useState('');
  if (candidates.length === 0) return null;
  return (
    <div style={{ marginTop: 8, display: 'flex', gap: 6 }}>
      <select value={pick} onChange={(e) => { setPick(e.target.value); }} style={{ flex: 1, fontSize: 12 }}>
        <option value="">Invite…</option>
        {candidates.map((u) => (
          <option key={u.userId} value={u.userId}>{u.name}</option>
        ))}
      </select>
      <button
        className="btn"
        style={{ padding: '2px 10px', fontSize: 12 }}
        disabled={pick === ''}
        onClick={() => {
          onInvite({
            kind: 'create',
            table: 'memberships',
            rowId: `mem-${pick}-${String(Date.now())}`,
            fields: { userId: pick, role: 'editor' },
          });
          setPick('');
        }}
      >
        Add
      </button>
    </div>
  );
};

const ConfirmRevoke = ({
  name,
  workspaceName,
  onCancel,
  onConfirm,
}: {
  name: string;
  workspaceName: string;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactElement => (
  <div className="modal-backdrop" onClick={onCancel}>
    <div className="modal" onClick={(e) => { e.stopPropagation(); }}>
      <h3>Revoke {name}&apos;s access to {workspaceName}?</h3>
      <p className="mono">Their devices will be instructed to forget this workspace&apos;s data.</p>
      <div className="actions">
        <button className="btn" onClick={onCancel}>Cancel</button>
        <button className="btn danger" onClick={onConfirm}>Revoke access</button>
      </div>
    </div>
  </div>
);

const RemovedCard = ({
  workspaceName,
  onBack,
}: {
  workspaceName: string;
  onBack: () => void;
}): ReactElement => (
  <div className="removed-card">
    <h3>You were removed from {workspaceName}</h3>
    <p>This device has forgotten the workspace&apos;s data.</p>
    <div className="mono" style={{ fontSize: 11, color: 'var(--faint)' }}>
      store purged · outbox cleared · cursor reset
    </div>
    <div style={{ marginTop: 14 }}>
      <button className="btn" onClick={onBack}>Back to your workspaces</button>
    </div>
  </div>
);

const Ticker = ({ feed }: { feed: readonly { dir: string; label: string; seq?: number; kind: string }[] }): ReactElement => (
  <div className="ticker">
    {feed.length === 0 ? (
      <span className="idle">sync ticker — the wire, live</span>
    ) : (
      feed.slice(-14).map((f, i) => (
        <span key={`${String(i)}-${f.label}`} className={f.kind === 'forget' ? 'forget' : f.dir === 'up' ? 'up' : 'down'}>
          {f.dir === 'up' ? '▲' : '▼'} {f.seq !== undefined ? `seq=${String(f.seq)} ` : ''}
          {f.label}
        </span>
      ))
    )}
  </div>
);
