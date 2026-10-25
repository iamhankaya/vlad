import type { EventLedger, LedgerEvent } from "./ledger.ts";

/** Where a stream writes. `http.ServerResponse` fits; tests use a recording sink. */
export interface Sink {
  write(chunk: string): boolean;
  end(): void;
  /** Bytes queued but not yet flushed to the socket. */
  readonly writableLength: number;
}

export const MAX_STREAMS = 64;
export const MAX_STREAMS_PER_DEVICE = 3;
export const MAX_BACKLOG_BYTES = 256 * 1024;
export const KEEPALIVE_MS = 20_000;

export type Admit = { ok: true; stream: Stream } | { ok: false; reason: "capacity" };

export interface Stream {
  readonly deviceId: string;
  close(): void;
}

export interface HubDeps {
  ledger: EventLedger;
  /** False once a device is revoked: checked at every write, besides the revoke hook. */
  isActive: (deviceId: string) => boolean;
  /** Repeating timer for the keepalive comment; returns its cancel. Injected, so tests never wait. */
  every?: (ms: number, fn: () => void) => () => void;
  maxStreams?: number;
  maxPerDevice?: number;
  maxBacklog?: number;
}

export const frame = (e: LedgerEvent): string => `id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;

/**
 * Open SSE streams. Bounded: {@link MAX_STREAMS} overall (a further connection is refused), {@link MAX_STREAMS_PER_DEVICE} per
 * device (a further one closes that device's oldest, since the old one is usually a dead socket after a network change).
 * A stream whose socket backlog grows past {@link MAX_BACKLOG_BYTES} is closed. Revoking a device closes all of its streams.
 */
export class SseHub {
  private readonly streams = new Set<Conn>();
  private readonly d: HubDeps;
  private readonly maxStreams: number;
  private readonly maxPerDevice: number;
  private readonly maxBacklog: number;

  constructor(d: HubDeps) {
    this.d = d;
    this.maxStreams = d.maxStreams ?? MAX_STREAMS;
    this.maxPerDevice = d.maxPerDevice ?? MAX_STREAMS_PER_DEVICE;
    this.maxBacklog = d.maxBacklog ?? MAX_BACKLOG_BYTES;
    d.ledger.onAppend((e) => this.broadcast(e));
  }

  get count(): number {
    return this.streams.size;
  }

  countFor(deviceId: string): number {
    let n = 0;
    for (const c of this.streams) if (c.deviceId === deviceId) n++;
    return n;
  }

  /**
   * Opens a stream: replays retained events after `lastEventId` (none when null), then follows the ledger. Replay and
   * registration happen in the same tick, so no event falls between them. `onAdmit` runs once the stream is accepted.
   */
  open(deviceId: string, sink: Sink, lastEventId: number | null, onAdmit?: () => void): Admit {
    if (!this.d.isActive(deviceId)) return { ok: false, reason: "capacity" };
    const mine = [...this.streams].filter((c) => c.deviceId === deviceId);
    if (this.streams.size - (mine.length >= this.maxPerDevice ? 1 : 0) >= this.maxStreams) return { ok: false, reason: "capacity" };
    onAdmit?.(); // the caller sends its response headers here, once the connection is accepted
    if (mine.length >= this.maxPerDevice) mine[0]!.close();
    const conn = new Conn(deviceId, sink, () => this.streams.delete(conn));
    this.streams.add(conn);
    conn.send("retry: 3000\n\n");
    if (lastEventId !== null) {
      // client ahead of the ledger (it was reset or restored): nothing to replay, the client must refresh via GET /home
      if (lastEventId > this.d.ledger.lastSeq) conn.send(`: reset last_seq=${this.d.ledger.lastSeq}\n\n`);
      else if (this.d.ledger.hasGapAfter(lastEventId)) conn.send(`: gap first=${this.d.ledger.firstSeq}\n\n`);
      for (const e of this.d.ledger.after(lastEventId, Number.MAX_SAFE_INTEGER)) conn.send(frame(e)); // bounded by the ledger size
    }
    this.enforce(conn);
    if (this.d.every && !conn.closed) conn.stopTimer = this.d.every(KEEPALIVE_MS, () => this.keepalive(conn));
    return { ok: true, stream: conn };
  }

  /** Revocation hook: ends every stream of the device. */
  closeDevice(deviceId: string): number {
    let n = 0;
    for (const c of [...this.streams]) if (c.deviceId === deviceId) (c.close(), n++);
    return n;
  }

  closeAll(): void {
    for (const c of [...this.streams]) c.close();
  }

  private broadcast(e: LedgerEvent): void {
    const f = frame(e);
    for (const c of [...this.streams]) {
      if (!this.d.isActive(c.deviceId)) c.close(); // a revoked device gets nothing more, not even this event
      else {
        c.send(f);
        this.enforce(c);
      }
    }
  }

  private keepalive(c: Conn): void {
    if (!this.d.isActive(c.deviceId)) return c.close();
    c.send(": keepalive\n\n");
    this.enforce(c);
  }

  private enforce(c: Conn): void {
    if (!this.d.isActive(c.deviceId) || c.sink.writableLength > this.maxBacklog) c.close();
  }
}

class Conn implements Stream {
  closed = false;
  stopTimer: (() => void) | null = null;
  readonly deviceId: string;
  readonly sink: Sink;
  private readonly onClose: () => void;

  constructor(deviceId: string, sink: Sink, onClose: () => void) {
    this.deviceId = deviceId;
    this.sink = sink;
    this.onClose = onClose;
  }

  send(chunk: string): void {
    if (this.closed) return;
    try {
      this.sink.write(chunk);
    } catch {
      this.close();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTimer?.();
    this.onClose();
    try {
      this.sink.end();
    } catch { /* already gone */ }
  }
}
