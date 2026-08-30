// The Node adapter's entry point (backlog B8): HTTP (login + directory) and
// per-workspace WebSockets over the shared deterministic core. This is the
// local-dev and CI-parity runtime; Cloudflare runs the same core (ADR-007).
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  decodeClientFrame,
  encodeFrame,
  type ServerFrame,
} from '@syncline/protocol';
import {
  createWorkspace,
  workspaceStep,
  type ServerEffect,
  type ServerInput,
  type WorkspaceConfig,
  type WorkspaceState,
  type ServerStorage,
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
import { createSqliteStorage } from './sqlite.js';
import { mintToken, verifyToken } from './jwt.js';

const PORT = Number(process.env['PORT'] ?? 8787);
const SECRET = process.env['JWT_SECRET'] ?? 'dev-secret-not-for-prod';
const DB_DIR = process.env['SYNCLINE_DB'] ?? ':memory:';
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

interface Workspace {
  state: WorkspaceState;
  storage: ServerStorage;
  config: WorkspaceConfig;
  sockets: Map<string, WebSocket>;
}

const workspaces = new Map<string, Workspace>();

const getWorkspace = (workspaceId: string): Workspace | undefined => {
  if (!DEMO_WORKSPACES.some((w) => w.workspaceId === workspaceId)) return undefined;
  const existing = workspaces.get(workspaceId);
  if (existing !== undefined) return existing;
  const storage = createSqliteStorage(
    DB_DIR === ':memory:' ? ':memory:' : `${DB_DIR}/${workspaceId}.db`,
  );
  const config: WorkspaceConfig = {
    workspaceId,
    schemaVersion: DEMO_SCHEMA_VERSION,
    minWritableVersion: MIN_WRITABLE_VERSION,
    ruleset: DEMO_RULESET,
    migrateOp,
  };
  const created: Workspace = { state: createWorkspace(), storage, config, sockets: new Map() };
  if (storage.getMeta('seeded') !== '1') {
    storage.tx(() => {
      workspaceStep(created.state, config, storage, {
        type: 'seed',
        clientId: SEED_CLIENT_ID,
        ops: seedOps(workspaceId),
        now: Date.now(),
      });
      storage.setMeta('seeded', '1');
    });
  }
  workspaces.set(workspaceId, created);
  return created;
};

// --- Directory (C6): live membership view fed by the workspace outboxes ----
// Initialized from seeds, updated whenever a workspace step enqueues a
// membership change. In-process here; the CF adapter does the same via a
// DirectoryDO round-trip with alarm retry.

const directoryMembers = new Map<string, Set<string>>(
  DEMO_WORKSPACES.map((w) => [w.workspaceId, new Set(w.members.map((m) => m.userId))]),
);

const drainDirectory = (workspaceId: string, storage: ServerStorage): void => {
  for (const entry of storage.peekDirectory(100)) {
    const change = JSON.parse(entry.change) as { kind: string; userId: string };
    const members = directoryMembers.get(workspaceId);
    if (members !== undefined) {
      if (change.kind === 'delete') members.delete(change.userId);
      else members.add(change.userId);
    }
    storage.ackDirectory(entry.id);
  }
};

/** Run one core step inside a storage transaction, then flush effects —
 * commit-before-send, per the adapter contract (ADR-007). */
const step = (ws: Workspace, input: ServerInput): void => {
  const effects = ws.storage.tx(() => workspaceStep(ws.state, ws.config, ws.storage, input));
  for (const effect of effects) executeEffect(ws, effect);
  drainDirectory(ws.config.workspaceId, ws.storage);
};

const executeEffect = (ws: Workspace, effect: ServerEffect): void => {
  const socket = effect.type === 'setAttachment' ? undefined : ws.sockets.get(effect.connId);
  switch (effect.type) {
    case 'send':
      socket?.send(encodeFrame(effect.frame));
      break;
    case 'close':
      socket?.close(effect.code === 'NORMAL' ? 1000 : 4000);
      ws.sockets.delete(effect.connId);
      break;
    case 'setAttachment':
      break; // no hibernation in the Node adapter; state lives in memory
  }
};

const sendError = (socket: WebSocket, code: 'AUTH_FAILED' | 'BAD_FRAME', message: string): void => {
  const frame: ServerFrame = { t: 'error', code, message };
  socket.send(encodeFrame(frame));
  socket.close(4000);
};

// --- HTTP: login + directory ----------------------------------------------

const json = (res: ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type, authorization',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(body));
};

const readBody = async (req: IncomingMessage): Promise<string> => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString();
};

const httpServer = createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'OPTIONS') {
      json(res, 204, {});
      return;
    }
    if (req.method === 'POST' && url.pathname === '/auth/login') {
      const body = JSON.parse(await readBody(req)) as { userId?: string };
      const user = DEMO_USERS.find((u) => u.userId === body.userId);
      if (user === undefined) {
        json(res, 401, { error: 'unknown demo user' });
        return;
      }
      json(res, 200, {
        token: mintToken(user.userId, SECRET, Date.now(), TOKEN_TTL_MS),
        user,
      });
      return;
    }
    if (req.method === 'GET' && url.pathname === '/directory') {
      // Token-gated: a query parameter must not be able to enumerate another
      // principal's memberships (mirrors the Cloudflare adapter).
      const auth = req.headers.authorization ?? '';
      const claims = verifyToken(auth.replace(/^Bearer /i, ''), SECRET, Date.now());
      if (claims === null) {
        json(res, 401, { error: 'missing or invalid token' });
        return;
      }
      const userId = claims.sub;
      const list = DEMO_WORKSPACES.filter((w) =>
        directoryMembers.get(w.workspaceId)?.has(userId) === true,
      ).map((w) => ({ workspaceId: w.workspaceId, name: w.name }));
      json(res, 200, { workspaces: list });
      return;
    }
    json(res, 404, { error: 'not found' });
  })().catch(() => {
    json(res, 400, { error: 'bad request' });
  });
});

// --- WebSockets: /ws/:workspaceId ------------------------------------------

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (socket, req) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const match = /^\/ws\/([a-z0-9-]+)$/.exec(url.pathname);
  const ws = match === null ? undefined : getWorkspace(match[1] as string);
  if (ws === undefined) {
    sendError(socket, 'BAD_FRAME', 'unknown workspace');
    return;
  }
  const connId = randomUUID();
  let helloDone = false;

  socket.on('message', (data: Buffer | string) => {
    const frame = decodeClientFrame(String(data));
    if (frame === null) {
      sendError(socket, 'BAD_FRAME', 'malformed frame');
      return;
    }
    if (!helloDone) {
      if (frame.t !== 'hello') {
        sendError(socket, 'BAD_FRAME', 'expected hello');
        return;
      }
      const claims = verifyToken(frame.token, SECRET, Date.now());
      if (claims === null) {
        sendError(socket, 'AUTH_FAILED', 'invalid or expired token');
        return;
      }
      helloDone = true;
      ws.sockets.set(connId, socket);
      step(ws, {
        type: 'hello',
        connId,
        userId: claims.sub,
        clientId: frame.clientId,
        schemaVersion: frame.schemaVersion,
        ...(frame.cursor !== undefined ? { cursor: frame.cursor } : {}),
        now: Date.now(),
      });
      return;
    }
    step(ws, { type: 'frame', connId, frame, now: Date.now() });
  });

  socket.on('close', () => {
    if (ws.sockets.delete(connId)) {
      step(ws, { type: 'disconnect', connId, now: Date.now() });
    }
  });
});

httpServer.listen(PORT, () => {
  console.log(`syncline server-node listening on http://localhost:${String(PORT)}`);
  console.log(`workspaces: ${DEMO_WORKSPACES.map((w) => w.workspaceId).join(', ')} (db: ${DB_DIR})`);
});
