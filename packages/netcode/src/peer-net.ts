import { ChangeTracker } from './change-tracker'
import { ConnectionPool, type PeerJSPeer } from './connection-pool'
import { InterestGroup } from './interest-group'
import { decodeJson, decodeMessage, encodeDeltaPayload, encodeJson, encodeMessage } from './message-codec'
import {
  MessageFlag,
  MessageType,
  type ComponentSchema,
  type DeltaHandler,
  type DeltaSet,
  type EntityId,
  type GroupId,
  type InterestGroupConfig,
  type NetMessage,
  type PeerId,
  type PeerNetConfig,
} from './types'

/**
 * PeerNet — top-level peer-to-peer netcode facade.
 *
 * Responsibilities:
 *   - Owns the ConnectionPool (PeerJS connections)
 *   - Owns all InterestGroups (pub/sub routing)
 *   - Owns the ChangeTracker (minimal delta generation)
 *   - Routes raw inbound buffers to the correct group
 *   - RTT estimation via Ping/Pong
 *
 * Typical usage per game tick:
 *   1. ECS systems run; call net.markEntityDirty(eid) for any changed entity
 *   2. Call net.flushGroupDeltas(groupId, entityList) to compute+queue deltas
 *   3. InterestGroup tick fires automatically (setInterval) and sends queued data
 *
 * Incoming deltas from remote peers surface via net.onGroupDelta(groupId, handler).
 * Apply them to your ECS TypedArrays inside that handler.
 */
export class PeerNet {
  readonly localPeerId: PeerId

  private _config: Required<PeerNetConfig>
  private _pool: ConnectionPool
  private _groups = new Map<GroupId, InterestGroup>()
  private _tracker = new ChangeTracker()
  private _seq = 0
  private _ack = 0
  private _rttMs = 50
  private _gameEventHandlers: ((payload: ArrayBuffer, from: PeerId) => void)[] = []

  constructor(config: PeerNetConfig) {
    this.localPeerId = config.peerId
    this._config = {
      peerId: config.peerId,
      rttAlpha: config.rttAlpha ?? 0.125,
    }
    this._pool = new ConnectionPool()
    this._pool.onData((buf, from) => this._onRawData(buf, from))
    this._pool.onDisconnect(peerId => {
      for (const group of this._groups.values()) group.removePeer(peerId)
    })
  }

  // ---------------------------------------------------------------------------
  // PeerJS wiring
  // ---------------------------------------------------------------------------

  /** Attach the live PeerJS Peer instance after it opens. */
  attachPeer(peer: PeerJSPeer): void {
    this._pool.setPeer(peer)
  }

  // ---------------------------------------------------------------------------
  // Component schema
  // ---------------------------------------------------------------------------

  registerComponent(schema: ComponentSchema): void {
    this._tracker.registerComponent(schema)
  }

  unregisterComponent(componentId: number): void {
    this._tracker.unregisterComponent(componentId)
  }

  // ---------------------------------------------------------------------------
  // Group management
  // ---------------------------------------------------------------------------

  createGroup(config: InterestGroupConfig): InterestGroup {
    const existing = this._groups.get(config.id)
    if (existing) return existing

    const group = new InterestGroup(config, this.localPeerId)
    group.setSendFn((to, msg) => this._send(to, msg))
    group.startTick()
    this._groups.set(config.id, group)
    return group
  }

  destroyGroup(groupId: GroupId): void {
    const group = this._groups.get(groupId)
    if (!group) return
    group.dispose()
    this._groups.delete(groupId)
  }

  getGroup(groupId: GroupId): InterestGroup | undefined {
    return this._groups.get(groupId)
  }

  // ---------------------------------------------------------------------------
  // Peer connections
  // ---------------------------------------------------------------------------

  async connectPeer(peerId: PeerId): Promise<void> {
    await this._pool.connect(peerId)
  }

  disconnectPeer(peerId: PeerId): void {
    this._pool.disconnect(peerId)
    for (const group of this._groups.values()) {
      group.removePeer(peerId)
    }
  }

  onPeerDisconnect(handler: (peerId: PeerId) => void): () => void {
    return this._pool.onDisconnect(handler)
  }

  sendGameEvent(peerId: PeerId, payload: ArrayBuffer): void {
    this._send(peerId, {
      type: MessageType.GameEvent,
      flags: MessageFlag.None,
      seq: this._nextSeq(),
      ack: this._ack,
      payload,
    })
  }

  onGameEvent(handler: (payload: ArrayBuffer, from: PeerId) => void): () => void {
    this._gameEventHandlers.push(handler)
    return () => {
      const idx = this._gameEventHandlers.indexOf(handler)
      if (idx !== -1) this._gameEventHandlers.splice(idx, 1)
    }
  }

  // ---------------------------------------------------------------------------
  // Group subscriptions
  // ---------------------------------------------------------------------------

  /**
   * Subscribe the local peer to a group and introduce remote peers.
   * Sends a Subscribe control message to each remote peer.
   */
  joinGroup(groupId: GroupId, remotePeers: PeerId[]): void {
    const group = this._requireGroup(groupId)
    for (const p of remotePeers) group.addPeer(p)
    this._sendSubscribe(groupId, remotePeers)
  }

  /**
   * Leave a group: notify remote peers and remove local state.
   */
  leaveGroup(groupId: GroupId): void {
    const group = this._groups.get(groupId)
    if (!group) return
    const peers = [...group.peerIds]
    this._sendUnsubscribe(groupId, peers)
    for (const p of peers) group.removePeer(p)
  }

  // ---------------------------------------------------------------------------
  // Delta pipeline
  // ---------------------------------------------------------------------------

  markEntityDirty(entityId: EntityId): void {
    this._tracker.markDirty(entityId)
  }

  markEntitiesDirty(entities: EntityId[]): void {
    this._tracker.markDirtyBatch(entities)
  }

  invalidateEntity(entityId: EntityId): void {
    this._tracker.invalidateEntity(entityId)
  }

  /**
   * Compute deltas for dirty entities and push them into the group's send queue.
   * The group's tick interval handles the actual sending.
   *
   * Call once per game tick, after ECS systems run.
   */
  flushGroupDeltas(groupId: GroupId, entities: EntityId[]): void {
    const group = this._groups.get(groupId)
    if (!group) return
    const deltas: DeltaSet = this._tracker.flush(entities)
    if (deltas.length > 0) group.publishDeltas(deltas)
  }

  /**
   * Send a full-state sync to a newly joined peer for a given group.
   * Generates a snapshot of all registered component fields for all provided entities.
   */
  sendFullSync(groupId: GroupId, toPeer: PeerId, entities: EntityId[]): void {
    const group = this._groups.get(groupId)
    if (!group) return
    const deltas = this._tracker.fullSnapshot(entities)
    if (deltas.length === 0) return
    const payload = encodeDeltaPayload(groupId, deltas)
    this._send(toPeer, {
      type: MessageType.FullSync,
      flags: MessageFlag.Reliable,
      seq: this._nextSeq(),
      ack: this._ack,
      payload,
    })
  }

  onGroupDelta(groupId: GroupId, handler: DeltaHandler): () => void {
    return this._requireGroup(groupId).onDelta(handler)
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  get rttMs(): number { return this._rttMs }
  get dirtyEntityCount(): number { return this._tracker.dirtyCount }

  ping(peerId: PeerId): void {
    const buf = new ArrayBuffer(8)
    new DataView(buf).setFloat64(0, performance.now(), true)
    this._send(peerId, {
      type: MessageType.Ping,
      flags: MessageFlag.None,
      seq: this._nextSeq(),
      ack: this._ack,
      payload: buf,
    })
  }

  // ---------------------------------------------------------------------------
  // Teardown
  // ---------------------------------------------------------------------------

  dispose(): void {
    for (const group of this._groups.values()) group.dispose()
    this._groups.clear()
    this._pool.dispose()
  }

  // ---------------------------------------------------------------------------
  // Private routing
  // ---------------------------------------------------------------------------

  private _onRawData(buf: ArrayBuffer, from: PeerId): void {
    let msg: NetMessage
    try { msg = decodeMessage(buf) } catch { return }
    this._ack = msg.seq

    switch (msg.type) {
      case MessageType.Subscribe: {
        this._onSubscribe(msg, from)
        break
      }
      case MessageType.Unsubscribe: {
        this._onUnsubscribe(msg, from)
        break
      }
      case MessageType.DeltaUpdate:
      case MessageType.FullSync:
      case MessageType.LeadClaim: {
        // Route to the group that owns this peer
        for (const group of this._groups.values()) {
          if (group.peerIds.has(from)) group.handleMessage(msg, from)
        }
        break
      }
      case MessageType.GameEvent: {
        for (const h of this._gameEventHandlers) h(msg.payload, from)
        break
      }
      case MessageType.Ping: {
        this._send(from, {
          type: MessageType.Pong,
          flags: MessageFlag.None,
          seq: this._nextSeq(),
          ack: this._ack,
          payload: msg.payload,
        })
        break
      }
      case MessageType.Pong: {
        try {
          const sent = new DataView(msg.payload).getFloat64(0, true)
          const rtt = performance.now() - sent
          this._rttMs += this._config.rttAlpha * (rtt - this._rttMs)
        } catch { /* malformed */ }
        break
      }
    }
  }

  private _onSubscribe(msg: NetMessage, from: PeerId): void {
    try {
      const { groupId } = decodeJson(msg.payload)
      if (typeof groupId === 'string') this._groups.get(groupId)?.addPeer(from)
    } catch { /* malformed */ }
  }

  private _onUnsubscribe(msg: NetMessage, from: PeerId): void {
    try {
      const { groupId } = decodeJson(msg.payload)
      if (typeof groupId === 'string') this._groups.get(groupId)?.removePeer(from)
    } catch { /* malformed */ }
  }

  private _sendSubscribe(groupId: GroupId, peers: PeerId[]): void {
    const payload = encodeJson({ groupId })
    const msg: NetMessage = {
      type: MessageType.Subscribe,
      flags: MessageFlag.Reliable,
      seq: this._nextSeq(),
      ack: this._ack,
      payload,
    }
    for (const p of peers) this._send(p, msg)
  }

  private _sendUnsubscribe(groupId: GroupId, peers: PeerId[]): void {
    const payload = encodeJson({ groupId })
    const msg: NetMessage = {
      type: MessageType.Unsubscribe,
      flags: MessageFlag.Reliable,
      seq: this._nextSeq(),
      ack: this._ack,
      payload,
    }
    for (const p of peers) this._send(p, msg)
  }

  private _send(to: PeerId, msg: NetMessage): void {
    this._pool.send(to, encodeMessage(msg))
  }

  private _nextSeq(): number {
    return (this._seq = (this._seq + 1) & 0xffff)
  }

  private _requireGroup(groupId: GroupId): InterestGroup {
    const group = this._groups.get(groupId)
    if (!group) throw new Error(`Interest group "${groupId}" not found — call createGroup() first`)
    return group
  }
}
