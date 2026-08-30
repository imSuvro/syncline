// BrowserRuntime: wires the sans-IO core to real IO — WebSocket, IndexedDB,
// timers, the wall clock. Effects execute strictly in order; storage
// barriers are awaited before any later send leaves (ADR-001).
import type { ClientFrame, Op, ServerFrame } from '@syncline/protocol';
import { decodeServerFrame, encodeFrame } from '@syncline/protocol';
import { clientStep, createClient, decodeStored } from '../core/engine.js';
import { pendingCount, queryTable, type ViewRow } from '../core/view.js';
import type {
  ClientEffect,
  ClientEvent,
  ClientInput,
  ClientState,
  ConnectionPhase,
  TimerKind,
} from '../core/types.js';
import { createIdbStorage, createMemoryClientStorage, type ClientStorage } from './idb.js';

/** One line of the sync ticker (docs/ux.md): the wire, made visible. */
export interface FeedFrame {
  dir: 'up' | 'down';
  label: string;
  seq?: number;
  kind: 'op' | 'push' | 'forget' | 'meta';
}

const FEED_MAX = 50;

export interface SynclineClientOptions {
  /** http(s) base of the sync server, e.g. https://syncline.example.com */
  serverUrl: string;
  token: string;
  workspaceId: string;
  clientId: string;
  schemaVersion: number;
  storage?: ClientStorage;
}

export class SynclineClient {
  private readonly opts: SynclineClientOptions;
  private readonly state: ClientState;
  private readonly storage: ClientStorage;
  private socket: WebSocket | undefined;
  private readonly timers = new Map<TimerKind, ReturnType<typeof setTimeout>>();
  private readonly subscribers = new Map<string, () => void>();
  private readonly eventListeners = new Set<(event: ClientEvent) => void>();
  private chain: Promise<void> = Promise.resolve();
  private pendingWrites: Promise<void> = Promise.resolve();
  private simulatedOffline = false;
  private readonly feed: FeedFrame[] = [];
  private readonly feedListeners = new Set<() => void>();

  constructor(opts: SynclineClientOptions) {
    this.opts = opts;
    this.storage =
      opts.storage ??
      (typeof indexedDB === 'undefined'
        ? createMemoryClientStorage()
        : createIdbStorage(`syncline-${opts.workspaceId}-${opts.clientId}`));
    this.state = createClient({
      clientId: opts.clientId,
      workspaceId: opts.workspaceId,
      schemaVersion: opts.schemaVersion,
    });
  }

  async start(): Promise<void> {
    const records = await this.storage.loadAll();
    this.input({
      type: 'boot',
      stored: decodeStored(records),
      online: this.isOnline(),
      now: Date.now(),
    });
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        this.input({ type: 'connectivity', online: this.isOnline(), now: Date.now() });
      });
      window.addEventListener('offline', () => {
        this.input({ type: 'connectivity', online: false, now: Date.now() });
      });
    }
  }

  private isOnline(): boolean {
    if (this.simulatedOffline) return false;
    return typeof navigator === 'undefined' ? true : navigator.onLine;
  }

  /** The demo's honest cheat: the pill's "Simulate offline" toggle. */
  setSimulatedOffline(offline: boolean): void {
    this.simulatedOffline = offline;
    this.input({ type: 'connectivity', online: this.isOnline(), now: Date.now() });
  }

  mutate(op: Op): void {
    this.input({ type: 'localMutation', op, now: Date.now() });
  }

  getTable(table: string): ViewRow[] {
    return queryTable(this.state, table);
  }

  get pending(): number {
    return pendingCount(this.state);
  }

  get phase(): ConnectionPhase {
    return this.state.phase;
  }

  get presence(): string[] {
    return this.state.presence;
  }

  /** Subscribe to change notifications for a table; returns unsubscribe. */
  subscribe(table: string, onChange: () => void): () => void {
    const queryId = `${table}#${String(this.subscribers.size)}-${String(Date.now())}`;
    this.subscribers.set(queryId, onChange);
    this.input({ type: 'subscribe', queryId, query: { table }, now: Date.now() });
    return () => {
      this.subscribers.delete(queryId);
      this.input({ type: 'unsubscribe', queryId, now: Date.now() });
    };
  }

  onEvent(listener: (event: ClientEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  /** The sync ticker's contents, newest last. */
  getFeed(): readonly FeedFrame[] {
    return this.feed;
  }

  onFeed(listener: () => void): () => void {
    this.feedListeners.add(listener);
    return () => this.feedListeners.delete(listener);
  }

  private pushFeed(frame: FeedFrame): void {
    this.feed.push(frame);
    if (this.feed.length > FEED_MAX) this.feed.shift();
    for (const listener of this.feedListeners) listener();
  }

  // --- core plumbing -------------------------------------------------------

  private input(input: ClientInput): void {
    // Serialize steps: each step's effects finish (incl. awaited barriers)
    // before the next step runs. The catch is load-bearing: without it a
    // single storage failure would reject the chain and every later step
    // would be skipped in silence — the engine would look alive and accept
    // nothing.
    this.chain = this.chain.then(async () => {
      const effects = clientStep(this.state, input);
      for (const effect of effects) await this.execute(effect);
    }).catch((cause: unknown) => {
      for (const listener of this.eventListeners) {
        listener({ kind: 'protocolError', code: `storage: ${String(cause)}` });
      }
    });
  }

  private async execute(effect: ClientEffect): Promise<void> {
    switch (effect.type) {
      case 'storageWrite': {
        // Queue behind prior writes rather than racing them: batches must
        // land in emission order (a snapshot's clearAll must not overtake
        // the rows written after it).
        this.pendingWrites = this.pendingWrites.then(() => this.storage.applyBatch(effect.records));
        return;
      }
      case 'storageBarrier':
        await this.pendingWrites;
        return;
      case 'connect':
        this.openSocket();
        return;
      case 'disconnect':
        this.socket?.close();
        this.socket = undefined;
        return;
      case 'send': {
        const frame: ClientFrame =
          effect.frame.t === 'hello' ? { ...effect.frame, token: this.opts.token } : effect.frame;
        if (frame.t === 'push') {
          for (const op of frame.ops) {
            this.pushFeed({
              dir: 'up',
              kind: 'push',
              label: `push op=${String(op.opId)} ${op.op.kind === 'update' ? op.op.field : op.op.kind}`,
            });
          }
        } else if (frame.t === 'hello') {
          this.pushFeed({ dir: 'up', kind: 'meta', label: `hello v${String(frame.schemaVersion)}` });
        }
        this.socket?.send(encodeFrame(frame));
        return;
      }
      case 'setTimer': {
        const existing = this.timers.get(effect.kind);
        if (existing !== undefined) clearTimeout(existing);
        this.timers.set(
          effect.kind,
          setTimeout(() => {
            this.timers.delete(effect.kind);
            this.input({ type: 'timerFired', kind: effect.kind, now: Date.now() });
          }, effect.afterMs),
        );
        return;
      }
      case 'clearTimer': {
        const timer = this.timers.get(effect.kind);
        if (timer !== undefined) clearTimeout(timer);
        this.timers.delete(effect.kind);
        return;
      }
      case 'notifyQueries':
        for (const id of effect.ids) this.subscribers.get(id)?.();
        return;
      case 'emitEvent':
        for (const listener of this.eventListeners) listener(effect.event);
        return;
    }
  }

  private recordIncoming(frame: ServerFrame): void {
    switch (frame.t) {
      case 'ops':
        for (const entry of frame.ops) {
          this.pushFeed({
            dir: 'down',
            kind: 'op',
            seq: entry.seq,
            label: `${entry.op.rowId} ${entry.op.kind === 'update' ? entry.op.field : entry.op.kind}`,
          });
        }
        return;
      case 'snapshot':
        this.pushFeed({
          dir: 'down',
          kind: 'meta',
          seq: frame.atSeq,
          label: `snapshot ${String(frame.rows.length)} rows`,
        });
        return;
      case 'forget':
        this.pushFeed({
          dir: 'down',
          kind: 'forget',
          seq: frame.upToSeq,
          label: `forget workspace=${this.opts.workspaceId}`,
        });
        return;
      default:
        return;
    }
  }

  private openSocket(): void {
    if (this.socket !== undefined) return;
    const wsBase = this.opts.serverUrl.replace(/^http/, 'ws');
    const socket = new WebSocket(`${wsBase}/ws/${this.opts.workspaceId}`);
    this.socket = socket;
    socket.onopen = () => {
      this.input({ type: 'transportOpen', now: Date.now() });
    };
    socket.onmessage = (ev: MessageEvent) => {
      const frame: ServerFrame | null = decodeServerFrame(String(ev.data));
      if (frame === null) return;
      this.recordIncoming(frame);
      this.input({ type: 'serverFrame', frame, now: Date.now() });
    };
    socket.onclose = () => {
      if (this.socket === socket) this.socket = undefined;
      this.input({ type: 'transportClosed', now: Date.now() });
    };
  }
}
