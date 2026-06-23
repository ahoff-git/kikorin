import type { PeerId } from './types'

// ---------------------------------------------------------------------------
// PeerJS duck-type interfaces — no direct peerjs npm dependency needed.
// Inject a real Peer instance via setPeer().
// ---------------------------------------------------------------------------

export interface PeerJSDataConnection {
  readonly peer: string
  readonly open: boolean
  send(data: ArrayBuffer | Uint8Array): void
  close(): void
  on(event: 'data',  cb: (data: unknown) => void): void
  on(event: 'open',  cb: () => void): void
  on(event: 'close', cb: () => void): void
  on(event: 'error', cb: (err: Error) => void): void
}

export interface PeerJSPeer {
  readonly id: string
  connect(peerId: string, options?: { reliable?: boolean; serialization?: string }): PeerJSDataConnection
  on(event: 'connection', cb: (conn: PeerJSDataConnection) => void): void
  on(event: 'open',  cb: (id: string) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  on(event: 'close', cb: () => void): void
  destroy(): void
}

// ---------------------------------------------------------------------------

type ConnState = 'pending' | 'open' | 'closed' | 'error'

interface ManagedConn {
  conn: PeerJSDataConnection
  state: ConnState
  queue: ArrayBuffer[]
  resolve: () => void
  reject: (e: Error) => void
  openPromise: Promise<void>
}

type DataHandler = (data: ArrayBuffer, from: PeerId) => void
type DisconnectHandler = (peerId: PeerId) => void

/**
 * Manages the lifecycle of PeerJS data connections.
 * Provides:
 *   - Lazy connection (auto-connects on first send)
 *   - Per-connection message queue drained on open
 *   - Exponential-backoff reconnect on close/error
 *   - Deduplication of inbound vs outbound connections to the same peer
 */
export class ConnectionPool {
  private _peer: PeerJSPeer | null = null
  private _conns = new Map<PeerId, ManagedConn>()
  private _handlers = new Set<DataHandler>()
  private _disconnectHandlers = new Set<DisconnectHandler>()
  // Reconnect state: peerId → current delay ms
  private _reconnectDelay = new Map<PeerId, number>()
  private _reconnectHandles = new Map<PeerId, ReturnType<typeof setTimeout>>()
  private static readonly BASE_DELAY = 500
  private static readonly MAX_DELAY  = 30_000

  setPeer(peer: PeerJSPeer): void {
    this._peer = peer
    peer.on('connection', conn => this._registerConn(conn.peer, conn))
  }

  async connect(peerId: PeerId): Promise<void> {
    const existing = this._conns.get(peerId)
    if (existing?.state === 'open') return
    if (existing?.state === 'pending') return existing.openPromise
    if (!this._peer) throw new Error('Peer not initialized — call setPeer() first')
    const conn = this._peer.connect(peerId, { reliable: false, serialization: 'binary' })
    this._registerConn(peerId, conn)
    return this._conns.get(peerId)!.openPromise
  }

  send(peerId: PeerId, data: ArrayBuffer): void {
    const managed = this._conns.get(peerId)
    if (!managed) {
      // Lazy connect — queue and fire
      void this.connect(peerId).then(() => this.send(peerId, data)).catch(() => {})
      return
    }
    if (managed.state === 'open') {
      managed.conn.send(data)
    } else {
      managed.queue.push(data)
    }
  }

  isOpen(peerId: PeerId): boolean {
    return this._conns.get(peerId)?.state === 'open'
  }

  disconnect(peerId: PeerId): void {
    clearTimeout(this._reconnectHandles.get(peerId))
    this._reconnectHandles.delete(peerId)
    this._reconnectDelay.delete(peerId)
    const managed = this._conns.get(peerId)
    if (managed) { managed.conn.close(); this._conns.delete(peerId) }
  }

  onData(handler: DataHandler): () => void {
    this._handlers.add(handler)
    return () => this._handlers.delete(handler)
  }

  /** Fires when a connection closes unexpectedly (not from a local disconnect() call). */
  onDisconnect(handler: DisconnectHandler): () => void {
    this._disconnectHandlers.add(handler)
    return () => this._disconnectHandlers.delete(handler)
  }

  dispose(): void {
    for (const h of this._reconnectHandles.values()) clearTimeout(h)
    this._reconnectHandles.clear()
    for (const m of this._conns.values()) m.conn.close()
    this._conns.clear()
    this._peer?.destroy()
    this._peer = null
  }

  // ---------------------------------------------------------------------------

  private _registerConn(peerId: PeerId, conn: PeerJSDataConnection): void {
    // Prefer keeping an existing open outbound connection over an inbound one
    const existing = this._conns.get(peerId)
    if (existing?.state === 'open') return

    let resolve!: () => void
    let reject!: (e: Error) => void
    const openPromise = new Promise<void>((res, rej) => { resolve = res; reject = rej })

    const managed: ManagedConn = { conn, state: 'pending', queue: [], resolve, reject, openPromise }
    this._conns.set(peerId, managed)

    conn.on('open', () => {
      managed.state = 'open'
      this._reconnectDelay.delete(peerId)
      clearTimeout(this._reconnectHandles.get(peerId))
      this._reconnectHandles.delete(peerId)
      for (const buf of managed.queue) conn.send(buf)
      managed.queue = []
      resolve()
    })

    conn.on('data', raw => {
      const buf: ArrayBuffer | null = raw instanceof ArrayBuffer ? raw
        : raw instanceof Uint8Array ? raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer
        : null
      if (!buf) return
      for (const h of this._handlers) h(buf, peerId)
    })

    conn.on('close', () => {
      managed.state = 'closed'
      for (const h of this._disconnectHandlers) h(peerId)
      this._scheduleReconnect(peerId)
    })

    conn.on('error', err => {
      managed.state = 'error'
      reject(err)
      this._scheduleReconnect(peerId)
    })
  }

  private _scheduleReconnect(peerId: PeerId): void {
    if (!this._peer) return
    const prev = this._reconnectDelay.get(peerId) ?? ConnectionPool.BASE_DELAY / 2
    const delay = Math.min(prev * 2, ConnectionPool.MAX_DELAY)
    this._reconnectDelay.set(peerId, delay)
    clearTimeout(this._reconnectHandles.get(peerId))
    const handle = setTimeout(() => {
      if (this._conns.get(peerId)?.state !== 'open') {
        void this.connect(peerId).catch(() => {})
      }
    }, delay)
    this._reconnectHandles.set(peerId, handle)
  }
}
