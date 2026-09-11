import { EventEmitter } from 'events';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';

export type SyncStatus = {
  connected: boolean;
  url: string;
  sessionId: string | null;
  peers: number;
  lastError: string | null;
  /** The id the SERVER registered us under. "Is this job mine?" must compare
   *  against this, not a display name — with operator profiles gone, every
   *  client reports the same name and names no longer identify anyone. */
  clientId: string;
};

export type RemoteObject = {
  id: string;
  ownerId: string;
  title: string;
  fallbacks?: string[];
  lat: number;
  lon: number;
  altFt: number;
  headingDeg: number;
  onGround: boolean;
  meta?: Record<string, unknown>;
};

export type PublishInput = {
  title: string;
  fallbacks?: string[];
  lat: number;
  lon: number;
  altFt?: number;
  headingDeg?: number;
  onGround?: boolean;
  kind?: string;
  meta?: Record<string, unknown>;
};

export type PresenceInput = {
  lat: number;
  lon: number;
  altFt: number;
  headingDeg: number;
  groundSpeedKt: number;
  onGround: boolean;
  callsign: string;
  aircraft: string;
  phase: string;
};

export type PeerPresence = PresenceInput & { clientId: string; at: number };

/**
 * Connects the app to dispatcher-api so injected objects are shared with every
 * other unit responding to the same job (session). Objects a peer creates are
 * emitted as `remoteCreate` / `remoteRemove` for the SimConnect bridge to mirror.
 */
export const DEFAULT_SYNC_URL = 'ws://139.99.195.169:3100/ws';

export class SyncClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private readonly clientId: string;
  /** Id the server actually registered us under — usually === clientId, but the
   *  server appends a suffix if another connection already holds this id. All
   *  "is this my own object?" filtering must use this, not clientId. */
  private effectiveClientId: string;
  private url: string;
  private token: string;
  private desiredSession: string | null = null;
  private helloedSession: string | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  private status: SyncStatus;

  constructor(clientId: string, opts?: { url?: string; token?: string }) {
    super();
    this.clientId = clientId;
    this.effectiveClientId = clientId;
    this.url = opts?.url || process.env.DISPATCHER_SYNC_URL || DEFAULT_SYNC_URL;
    this.token = opts?.token || process.env.DISPATCHER_SYNC_TOKEN || '';
    this.status = { connected: false, url: this.url, sessionId: null, peers: 0, lastError: null, clientId };
  }

  getStatus(): SyncStatus {
    return this.status;
  }

  getConfig(): { url: string; token: string } {
    return { url: this.url, token: this.token };
  }

  /** Point at a different sync server. Reconnects to the current session. */
  setUrl(url: string, token?: string): void {
    const next = (url || '').trim() || DEFAULT_SYNC_URL;
    if (next === this.url && (token === undefined || token === this.token)) return;
    this.url = next;
    if (token !== undefined) this.token = token.trim();
    this.patch({ url: this.url, lastError: null });
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.desiredSession) this.connect();
  }

  /** Join (or leave, with null) a session. Everyone in the same session shares objects. */
  setSession(sessionId: string | null): void {
    if (sessionId === this.desiredSession) return;
    this.desiredSession = sessionId;
    this.stopped = false;
    if (!sessionId) {
      this.teardown('Left session.');
      return;
    }
    // The server binds a connection to its first `hello` and ignores later ones,
    // so a session change means a fresh connection.
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.helloedSession = null;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.desiredSession = null;
    this.teardown('Sync stopped.');
  }

  /** tempId -> server object id, for objects WE created (so we can move them) */
  private ownObjectIds = new Map<string, string>();

  /** @returns { sent, tempId } — keep tempId to correlate with `ownObject` / update it */
  publishObject(input: PublishInput): { sent: boolean; tempId: string } {
    const tempId = randomUUID();
    const sent = this.send({
      type: 'object.create',
      object: {
        tempId,
        kind: input.kind ?? 'other',
        title: input.title,
        fallbacks: input.fallbacks,
        lat: input.lat,
        lon: input.lon,
        altFt: input.altFt ?? 0,
        headingDeg: input.headingDeg ?? 0,
        onGround: input.onGround ?? true,
        meta: input.meta,
      },
    });
    return { sent, tempId };
  }

  /** Server id for one of our published objects, once the server has echoed it. */
  ownObjectId(tempId: string): string | undefined {
    return this.ownObjectIds.get(tempId);
  }

  /** Move an object we own (a moving contact). */
  updateObject(serverId: string, p: { lat: number; lon: number; altFt: number; headingDeg: number }): boolean {
    return this.send({ type: 'object.update', id: serverId, lat: p.lat, lon: p.lon, altFt: p.altFt, headingDeg: p.headingDeg });
  }

  removeMine(): void {
    this.send({ type: 'object.removeMine' });
    this.ownObjectIds.clear();
  }

  get connectedSession(): string | null {
    return this.helloedSession;
  }

  /** Broadcast our aircraft position to peers in the session (throttled by the caller). */
  sendPresence(p: PresenceInput): void {
    if (!this.helloedSession) return;
    this.send({ type: 'presence', ...p });
  }

  // --- internals ----------------------------------------------------------

  private patch(next: Partial<SyncStatus>): void {
    this.status = { ...this.status, ...next };
    this.emit('status', this.status);
  }

  private connect(): void {
    if (this.stopped || !this.desiredSession || this.ws) return;
    const target = this.token ? `${this.url}?token=${encodeURIComponent(this.token)}` : this.url;
    let ws: WebSocket;
    try {
      ws = new WebSocket(target);
    } catch (err) {
      this.patch({ lastError: err instanceof Error ? err.message : String(err) });
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.hello();
      // Keepalive must not be gated on `helloedSession` (as `send()` is) or a
      // slow welcome would suppress it and the server would idle us out.
      this.pingTimer = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'ping' }));
      }, 15_000);
      this.pingTimer.unref?.();
    });
    ws.on('message', (raw) => this.onMessage(raw.toString()));
    ws.on('error', (err: Error) => this.patch({ lastError: err.message }));
    ws.on('close', () => {
      this.ws = null;
      this.helloedSession = null;
      this.effectiveClientId = this.clientId;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.patch({ connected: false, peers: 0 });
      this.scheduleReconnect();
    });
  }

  /** Operator name sent in `hello` (from the signed-in account) and job claims. */
  private operatorName = 'Operator';
  setOperatorName(name: string): void {
    const n = (name || '').trim() || 'Operator';
    if (n === this.operatorName) return;
    this.operatorName = n;
    // Re-hello so the server (and job claims) show the current operator.
    if (this.ws && this.helloedSession && this.desiredSession) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
  }
  getOperatorName(): string {
    return this.operatorName;
  }

  private hello(): void {
    if (!this.desiredSession || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(
      JSON.stringify({
        type: 'hello',
        sessionId: this.desiredSession,
        clientId: this.clientId,
        name: this.operatorName,
        token: this.token || undefined,
      }),
    );
  }

  // --- shared job pool --------------------------------------------------
  /** Tell the server roughly where we are so new jobs land within reach. */
  locateForJobs(lat: number, lon: number, channel: 'emergency' | 'raafv' = 'emergency'): boolean {
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
    return this.send({ type: 'job.locate', lat, lon, channel });
  }
  claimJob(jobId: string): boolean {
    return this.send({ type: 'job.claim', jobId, name: this.operatorName });
  }
  joinJob(jobId: string): boolean {
    return this.send({ type: 'job.join', jobId, name: this.operatorName });
  }
  leaveJob(jobId: string): boolean {
    return this.send({ type: 'job.leave', jobId });
  }
  releaseJob(jobId: string): boolean {
    return this.send({ type: 'job.release', jobId });
  }
  startJob(jobId: string): boolean {
    return this.send({ type: 'job.start', jobId });
  }
  jobProgress(jobId: string, phase: string): boolean {
    return this.send({ type: 'job.progress', jobId, phase });
  }
  completeJob(jobId: string): boolean {
    return this.send({ type: 'job.complete', jobId });
  }

  private scheduleReconnect(): void {
    if (this.stopped || !this.desiredSession || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, 5000);
    this.reconnectTimer.unref?.();
  }

  private teardown(reason: string): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
    this.helloedSession = null;
    this.effectiveClientId = this.clientId;
    this.patch({ connected: false, sessionId: null, peers: 0, lastError: reason });
  }

  private send(msg: unknown): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.helloedSession) {
      this.ws.send(JSON.stringify(msg));
      return true;
    }
    return false;
  }

  private onMessage(text: string): void {
    let msg: { type: string; [k: string]: unknown };
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    switch (msg.type) {
      case 'welcome': {
        this.helloedSession = (msg.sessionId as string) ?? null;
        this.effectiveClientId = (msg.clientId as string) || this.clientId;
        this.patch({ connected: true, sessionId: this.helloedSession, lastError: null, clientId: this.effectiveClientId });
        break;
      }
      case 'snapshot': {
        for (const obj of (msg.objects as RemoteObject[]) ?? []) {
          if (obj.ownerId !== this.effectiveClientId) this.emit('remoteCreate', obj);
        }
        break;
      }
      case 'object.created': {
        const obj = msg.object as RemoteObject;
        const tempId = msg.tempId as string | undefined;
        if (obj && obj.ownerId === this.effectiveClientId) {
          if (tempId) {
            this.ownObjectIds.set(tempId, obj.id);
            this.emit('ownObject', { tempId, id: obj.id });
          }
        } else if (obj) {
          this.emit('remoteCreate', obj);
        }
        break;
      }
      case 'object.updated': {
        const obj = msg.object as RemoteObject;
        if (obj && obj.ownerId !== this.effectiveClientId) this.emit('remoteUpdate', obj);
        break;
      }
      case 'object.removed': {
        this.emit('remoteRemove', msg.id as string);
        break;
      }
      case 'peer.presence': {
        this.emit('peerPresence', msg as unknown as PeerPresence);
        break;
      }
      case 'peer.joined':
      case 'peer.left': {
        this.patch({ peers: (msg.count as number) ?? this.status.peers });
        if (msg.type === 'peer.left') this.emit('peerLeft', msg.clientId as string);
        break;
      }
      case 'job.list': {
        this.emit('jobList', (msg.jobs as unknown[]) ?? []);
        break;
      }
      case 'job.upsert': {
        this.emit('jobUpsert', msg.job);
        break;
      }
      case 'job.remove': {
        this.emit('jobRemove', msg.id as string);
        break;
      }
      case 'error': {
        this.patch({ lastError: (msg.message as string) ?? 'sync error' });
        break;
      }
    }
  }
}
