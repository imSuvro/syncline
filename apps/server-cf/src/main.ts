// Cloudflare adapter (ADR-007): Worker router + WorkspaceDO (per-workspace
// sync authority over DO SQLite, WebSocket Hibernation) + DirectoryDO
// (login, workspace directory). All logic lives in @syncline/server; this
// file is translation.
import {
  decodeClientFrame,
  encodeFrame,
  type ServerFrame,
} from '@syncline/protocol';
import {
  createWorkspace,
  rehydrateConnection,
  workspaceStep,
  type ServerEffect,
  type ServerInput,
  type WorkspaceConfig,
  type WorkspaceState,
} from '@syncline/server';
import {
  DEMO_RULESET,
  DEMO_SCHEMA_VERSION,
  DEMO_USERS,
  DEMO_WORKSPACES,
  MIN_WRITABLE_VERSION,
  SEED_CLIENT_ID,
  migrateOp,
  seedOps,
} from 'syncline-demo-schema';
import { createDoStorage, initSchema } from './storage.js';
import { mintToken, verifyToken } from './jwt.js';

interface Bindings {
  WORKSPACE_DO: DurableObjectNamespace;
  DIRECTORY_DO: DurableObjectNamespace;
  JWT_SECRET: string;
}

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

const CORS = {
  'access-control-allow-origin': '*',
  // `authorization` must be listed or the browser's preflight rejects the
  // token-bearing directory request.
  'access-control-allow-headers': 'content-type, authorization',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
};

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...CORS } });

// --- Worker router ---------------------------------------------------------

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/auth/login' || url.pathname === '/directory') {
      const id = env.DIRECTORY_DO.idFromName('main');
      return env.DIRECTORY_DO.get(id).fetch(request);
    }
    const match = /^\/ws\/([a-z0-9-]+)$/.exec(url.pathname);
    if (match !== null) {
      const workspaceId = match[1] as string;
      if (!DEMO_WORKSPACES.some((w) => w.workspaceId === workspaceId)) {
        return json(404, { error: 'unknown workspace' });
      }
      const id = env.WORKSPACE_DO.idFromName(workspaceId);
      return env.WORKSPACE_DO.get(id).fetch(request);
    }
    return json(404, { error: 'not found' });
  },
};

// --- WorkspaceDO -----------------------------------------------------------

interface SocketMeta {
  connId: string;
  helloDone: boolean;
}

export class WorkspaceDO implements DurableObject {
  private readonly ctx: DurableObjectState;
  private readonly env: Bindings;
  private readonly state: WorkspaceState;
  private config: WorkspaceConfig;
  // Declared before the constructor: the constructor body repopulates them
  // from surviving sockets, so their initializers must have run first.
  private readonly sockets = new Map<string, WebSocket>();
  private readonly socketMeta = new Map<WebSocket, SocketMeta>();

  constructor(ctx: DurableObjectState, env: Bindings) {
    this.ctx = ctx;
    this.env = env;
    this.state = createWorkspace();
    initSchema(ctx.storage.sql);
    // The DO is addressed by name, but the name is not readable from the
    // object — so the id is persisted on first fetch and recovered here on
    // every later wake (including after hibernation).
    this.config = {
      workspaceId: createDoStorage(ctx).getMeta('workspaceId') ?? '',
      schemaVersion: DEMO_SCHEMA_VERSION,
      minWritableVersion: MIN_WRITABLE_VERSION,
      ruleset: DEMO_RULESET,
      migrateOp,
    };
    // Rebuild BOTH registries from hibernation-surviving sockets: the core's
    // connection state and this object's connId→socket map. Missing the
    // second one silently breaks every outbound frame addressed to a
    // connection this instance did not itself accept — including the forget
    // that revocation depends on.
    for (const ws of ctx.getWebSockets()) {
      const raw = ws.deserializeAttachment() as { pre?: string; conn?: string } | null;
      const blob = raw?.conn ?? raw?.pre;
      if (blob === undefined) continue;
      const connId = (JSON.parse(blob) as { connId?: string }).connId;
      if (connId === undefined) continue;
      this.sockets.set(connId, ws);
      this.socketMeta.set(ws, { connId, helloDone: raw?.conn !== undefined });
      if (raw?.conn !== undefined) rehydrateConnection(this.state, connId, raw.conn);
    }
  }

  private storage = () => createDoStorage(this.ctx);

  private seedIfNeeded(workspaceId: string): void {
    if (this.config.workspaceId !== workspaceId) {
      this.config = { ...this.config, workspaceId };
    }
    const storage = this.storage();
    if (storage.getMeta('seeded') === '1') return;
    storage.tx(() => {
      workspaceStep(this.state, this.config, storage, {
        type: 'seed',
        clientId: SEED_CLIENT_ID,
        ops: seedOps(workspaceId),
        now: Date.now(),
      });
      storage.setMeta('seeded', '1');
      storage.setMeta('workspaceId', workspaceId);
    });
  }

  fetch(request: Request): Response {
    const url = new URL(request.url);
    const workspaceId = url.pathname.split('/')[2] ?? '';
    this.seedIfNeeded(workspaceId);
    if (request.headers.get('Upgrade') !== 'websocket') {
      return json(426, { error: 'expected websocket' });
    }
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const connId = crypto.randomUUID();
    server.serializeAttachment({ pre: JSON.stringify({ connId }) });
    this.ctx.acceptWebSocket(server);
    this.sockets.set(connId, server);
    this.socketMeta.set(server, { connId, helloDone: false });
    return new Response(null, { status: 101, webSocket: client });
  }

  private metaFor(ws: WebSocket): SocketMeta {
    let meta = this.socketMeta.get(ws);
    if (meta === undefined) {
      // Hibernation wake: recover connId from the attachment.
      const raw = ws.deserializeAttachment() as { pre?: string; conn?: string } | null;
      const blob = raw?.conn ?? raw?.pre ?? '{}';
      const connId = (JSON.parse(blob) as { connId?: string }).connId ?? crypto.randomUUID();
      meta = { connId, helloDone: raw?.conn !== undefined };
      this.socketMeta.set(ws, meta);
      this.sockets.set(connId, ws);
    }
    return meta;
  }

  private step(input: ServerInput): void {
    const storage = this.storage();
    const effects = storage.tx(() => workspaceStep(this.state, this.config, storage, input));
    for (const effect of effects) this.execute(effect);
    // Directory propagation (C6): at-least-once, retried via alarm. The
    // alarm is armed BEFORE the flush and cleared on success, so an idle
    // eviction that cancels the in-flight subrequest still leaves a retry
    // scheduled — otherwise a revoke landing just before quiet would sit in
    // the outbox indefinitely.
    if (storage.peekDirectory(1).length > 0) {
      void this.ctx.storage.setAlarm(Date.now() + 30_000);
      this.ctx.waitUntil(this.flushDirectory());
    }
  }

  /** Drain the directory outbox to DirectoryDO; on failure, retry by alarm. */
  private async flushDirectory(): Promise<void> {
    const storage = this.storage();
    const workspaceId = storage.getMeta('workspaceId') ?? '';
    const pending = storage.peekDirectory(50);
    if (pending.length === 0) return;
    try {
      const id = this.env.DIRECTORY_DO.idFromName('main');
      const res = await this.env.DIRECTORY_DO.get(id).fetch('https://do/internal/membership', {
        method: 'POST',
        body: JSON.stringify({ workspaceId, changes: pending.map((p) => JSON.parse(p.change) as unknown) }),
      });
      if (!res.ok) throw new Error(`directory answered ${String(res.status)}`);
      for (const p of pending) storage.ackDirectory(p.id);
      if (storage.peekDirectory(1).length > 0) {
        await this.flushDirectory();
      } else {
        await this.ctx.storage.deleteAlarm();
      }
    } catch {
      void this.ctx.storage.setAlarm(Date.now() + 30_000);
    }
  }

  async alarm(): Promise<void> {
    await this.flushDirectory();
  }

  private execute(effect: ServerEffect): void {
    switch (effect.type) {
      case 'send':
        this.sockets.get(effect.connId)?.send(encodeFrame(effect.frame));
        break;
      case 'close': {
        const ws = this.sockets.get(effect.connId);
        this.sockets.delete(effect.connId);
        if (ws !== undefined) {
          this.socketMeta.delete(ws);
          ws.close(effect.code === 'NORMAL' ? 1000 : 4000, effect.code);
        }
        break;
      }
      case 'setAttachment': {
        const ws = this.sockets.get(effect.connId);
        ws?.serializeAttachment({ conn: effect.blob });
        break;
      }
    }
  }

  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    const meta = this.metaFor(ws);
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    const frame = decodeClientFrame(text);
    if (frame === null) {
      const err: ServerFrame = { t: 'error', code: 'BAD_FRAME', message: 'malformed frame' };
      ws.send(encodeFrame(err));
      ws.close(4000);
      return;
    }
    if (!meta.helloDone) {
      if (frame.t !== 'hello') {
        const err: ServerFrame = { t: 'error', code: 'BAD_FRAME', message: 'expected hello' };
        ws.send(encodeFrame(err));
        ws.close(4000);
        return;
      }
      const claims = await verifyToken(frame.token, this.env.JWT_SECRET, Date.now());
      if (claims === null) {
        const err: ServerFrame = { t: 'error', code: 'AUTH_FAILED', message: 'invalid or expired token' };
        ws.send(encodeFrame(err));
        ws.close(4000);
        return;
      }
      meta.helloDone = true;
      this.step({
        type: 'hello',
        connId: meta.connId,
        userId: claims.sub,
        clientId: frame.clientId,
        schemaVersion: frame.schemaVersion,
        ...(frame.cursor !== undefined ? { cursor: frame.cursor } : {}),
        now: Date.now(),
      });
      return;
    }
    this.step({ type: 'frame', connId: meta.connId, frame, now: Date.now() });
  }

  webSocketClose(ws: WebSocket): void {
    const meta = this.socketMeta.get(ws);
    if (meta === undefined) return;
    this.socketMeta.delete(ws);
    this.sockets.delete(meta.connId);
    if (meta.helloDone) this.step({ type: 'disconnect', connId: meta.connId, now: Date.now() });
  }
}

// --- DirectoryDO -----------------------------------------------------------

export class DirectoryDO implements DurableObject {
  private readonly env: Bindings;
  private readonly ctx: DurableObjectState;

  constructor(ctx: DurableObjectState, env: Bindings) {
    this.env = env;
    this.ctx = ctx;
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS members (workspaceId TEXT NOT NULL, userId TEXT NOT NULL, PRIMARY KEY (workspaceId, userId))',
    );
    // Seed the membership view once; workspace outboxes keep it live after.
    const seeded = ctx.storage.sql.exec("SELECT COUNT(*) AS n FROM members").toArray()[0] as { n: number };
    if (seeded.n === 0) {
      for (const w of DEMO_WORKSPACES) {
        for (const m of w.members) {
          ctx.storage.sql.exec('INSERT OR IGNORE INTO members (workspaceId, userId) VALUES (?, ?)', w.workspaceId, m.userId);
        }
      }
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const sql = this.ctx.storage.sql;
    if (request.method === 'POST' && url.pathname === '/auth/login') {
      const body = (await request.json()) as { userId?: string };
      const user = DEMO_USERS.find((u) => u.userId === body.userId);
      if (user === undefined) return json(401, { error: 'unknown demo user' });
      const token = await mintToken(user.userId, this.env.JWT_SECRET, Date.now(), TOKEN_TTL_MS);
      return json(200, { token, user });
    }
    if (request.method === 'GET' && url.pathname === '/directory') {
      // The directory lists a principal's workspaces, so it needs the token:
      // trusting a query parameter would let anyone enumerate anyone's
      // memberships. (Password-less persona login is deliberate; handing out
      // other people's data is not.)
      const auth = request.headers.get('authorization') ?? '';
      const claims = await verifyToken(auth.replace(/^Bearer /i, ''), this.env.JWT_SECRET, Date.now());
      if (claims === null) return json(401, { error: 'missing or invalid token' });
      const userId = claims.sub;
      const rows = sql
        .exec('SELECT workspaceId FROM members WHERE userId = ?', userId)
        .toArray() as { workspaceId: string }[];
      const list = rows
        .map((r) => DEMO_WORKSPACES.find((w) => w.workspaceId === r.workspaceId))
        .filter((w): w is (typeof DEMO_WORKSPACES)[number] => w !== undefined)
        .map((w) => ({ workspaceId: w.workspaceId, name: w.name }));
      return json(200, { workspaces: list });
    }
    if (request.method === 'POST' && url.pathname === '/internal/membership') {
      const body = (await request.json()) as {
        workspaceId: string;
        changes: { kind: string; userId: string }[];
      };
      for (const change of body.changes) {
        if (change.kind === 'delete') {
          sql.exec('DELETE FROM members WHERE workspaceId = ? AND userId = ?', body.workspaceId, change.userId);
        } else {
          sql.exec('INSERT OR IGNORE INTO members (workspaceId, userId) VALUES (?, ?)', body.workspaceId, change.userId);
        }
      }
      return json(200, { ok: true });
    }
    return json(404, { error: 'not found' });
  }
}
