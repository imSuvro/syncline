// React bindings over SynclineClient — the view-model contract from
// docs/ux.md, nothing more. The engine stays framework-agnostic; these
// hooks just subscribe to it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  SynclineClient,
  type ClientEvent,
  type ConnectionPhase,
  type FeedFrame,
  type ViewRow,
} from '@syncline/client';
import type { Op } from '@syncline/protocol';
import { DEMO_SCHEMA_VERSION } from 'syncline-demo-schema';
import { SERVER_URL } from './api.js';

/**
 * One durable device id per browser profile (ADR-002: minted at the edge).
 * `?device=` overrides it, so two tabs in one profile can stand in for two
 * devices — incognito gets its own storage and needs no override.
 */
const deviceId = (userId: string): string => {
  // Scoped per persona: the demo lets you switch users in one browser, and
  // a shared device id would boot the next persona from the previous one's
  // local store — cross-user data bleed in the app whose whole thesis is
  // that this cannot happen. The server also rejects a clientId claimed by
  // a different user, so a shared id would simply fail to connect.
  const override = new URLSearchParams(window.location.search).get('device');
  const suffix = override !== null && override !== '' ? `device-${override}` : null;
  if (suffix !== null) return `${userId}-${suffix}`;
  const key = `syncline.clientId.${userId}`;
  let id = localStorage.getItem(key);
  if (id === null) {
    id = crypto.randomUUID();
    localStorage.setItem(key, id);
  }
  return id;
};

export interface SyncSession {
  client: SynclineClient;
  phase: ConnectionPhase;
  pending: number;
  presence: string[];
  feed: readonly FeedFrame[];
  removed: boolean;
  rows(table: string): ViewRow[];
  mutate(op: Op): void;
  setSimulatedOffline(offline: boolean): void;
}

export const useSync = (token: string, userId: string, workspaceId: string): SyncSession | null => {
  const [client, setClient] = useState<SynclineClient | null>(null);
  // `version` counts engine notifications. It must appear in the memo deps
  // below — the setter is referentially stable, so depending on the setter
  // freezes every snapshot value (pending, presence, feed) at first render.
  const [version, bumpVersion] = useState(0);
  const [phase, setPhase] = useState<ConnectionPhase>('booting');
  const [removed, setRemoved] = useState(false);
  const tick = useCallback(() => {
    bumpVersion((n) => n + 1);
  }, []);

  useEffect(() => {
    if (workspaceId === 'none') return; // directory not loaded yet
    let disposed = false;
    const c = new SynclineClient({
      serverUrl: SERVER_URL,
      token,
      workspaceId,
      clientId: deviceId(userId),
      schemaVersion: DEMO_SCHEMA_VERSION,
    });
    const offEvent = c.onEvent((event: ClientEvent) => {
      if (event.kind === 'phase') setPhase(event.phase);
      if (event.kind === 'membershipRemoved') setRemoved(true);
      tick();
    });
    const offFeed = c.onFeed(tick);
    void c.start().then(() => {
      if (!disposed) setClient(c);
    });
    return () => {
      disposed = true;
      offEvent();
      offFeed();
    };
  }, [token, userId, workspaceId, tick]);

  // Re-render whenever any table this session shows changes.
  useEffect(() => {
    if (client === null) return;
    const offIssues = client.subscribe('issues', tick);
    const offMembers = client.subscribe('memberships', tick);
    return () => {
      offIssues();
      offMembers();
    };
  }, [client, tick]);

  return useMemo(() => {
    if (client === null) return null;
    return {
      client,
      phase,
      pending: client.pending,
      presence: client.presence,
      feed: client.getFeed(),
      removed,
      rows: (table: string) => client.getTable(table),
      mutate: (op: Op) => {
        client.mutate(op);
      },
      setSimulatedOffline: (offline: boolean) => {
        client.setSimulatedOffline(offline);
      },
    };
  }, [client, phase, removed, version]);
};

/** Flash a field for ~1.2s when it changes underneath you (docs/ux.md). */
export const useFlash = (): [(key: string) => boolean, (key: string) => void] => {
  const [flashing, setFlashing] = useState<Record<string, number>>({});
  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const flash = useCallback((key: string) => {
    setFlashing((f) => ({ ...f, [key]: Date.now() }));
    clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(() => {
      setFlashing((f) => Object.fromEntries(Object.entries(f).filter(([k]) => k !== key)));
    }, 1200);
  }, []);
  const isFlashing = useCallback((key: string) => flashing[key] !== undefined, [flashing]);
  return [isFlashing, flash];
};
