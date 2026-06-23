import { decodeDeltaPayload, decodeJson, encodeDeltaPayload, encodeJson } from './message-codec'
import { LeadElector } from './lead-election'
import {
  MessageFlag,
  MessageType,
  type DeltaHandler,
  type DeltaSet,
  type ElectionStrategy,
  type GroupId,
  type InterestGroupConfig,
  type NetMessage,
  type PeerId,
} from './types'

export interface PeerState {
  readonly peerId: PeerId
  isLead: boolean
  joinedAt: number
  lastSeenAt: number
  rttMs: number
}

export type SendFn = (to: PeerId, msg: NetMessage) => void

/**
 * Manages one interest group: membership, lead election, and message routing.
 *
 * Routing rules:
 *   - Non-lead peers send outbound deltas → lead only
 *   - Lead receives deltas → re-broadcasts to all other group peers + notifies local handlers
 *   - Local delta handlers always fire regardless of lead status
 *
 * Lead election is deterministic (all peers run the same algorithm) and
 * re-runs on every membership change. No election messages are needed for
 * convergence; LeadClaim messages just inform remote peers of the local result.
 */
export class InterestGroup {
  readonly id: GroupId

  private _config: Required<InterestGroupConfig>
  private _localPeerId: PeerId
  private _peers = new Map<PeerId, PeerState>()
  private _leadId: PeerId | null = null
  private _elector: LeadElector
  private _sendFn: SendFn | null = null
  private _deltaHandlers = new Set<DeltaHandler>()
  private _pending: DeltaSet = []
  private _tickHandle: ReturnType<typeof setInterval> | null = null
  private _seq = 0
  private _ack = 0

  constructor(config: InterestGroupConfig, localPeerId: PeerId) {
    this.id = config.id
    this._config = {
      id: config.id,
      maxEntities: config.maxEntities ?? 4096,
      tickRateMs: config.tickRateMs ?? 50,
      electionStrategy: config.electionStrategy ?? 'min-id',
    }
    this._localPeerId = localPeerId
    this._elector = new LeadElector(this._config.electionStrategy as ElectionStrategy)
  }

  // ---------------------------------------------------------------------------
  // Accessors
  // ---------------------------------------------------------------------------

  get leadId(): PeerId | null { return this._leadId }
  get isLead(): boolean { return this._leadId === this._localPeerId }
  get peerCount(): number { return this._peers.size }

  getPeer(peerId: PeerId): Readonly<PeerState> | undefined {
    return this._peers.get(peerId)
  }

  get peerIds(): ReadonlySet<PeerId> {
    return new Set(this._peers.keys())
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  setSendFn(fn: SendFn): void { this._sendFn = fn }

  // ---------------------------------------------------------------------------
  // Membership
  // ---------------------------------------------------------------------------

  addPeer(peerId: PeerId): void {
    if (this._peers.has(peerId)) return
    this._peers.set(peerId, {
      peerId,
      isLead: false,
      joinedAt: Date.now(),
      lastSeenAt: Date.now(),
      rttMs: 0,
    })
    this._reelect()
  }

  removePeer(peerId: PeerId): void {
    if (!this._peers.has(peerId)) return
    this._peers.delete(peerId)
    this._elector.removeLoadInfo(peerId)
    if (this._leadId === peerId) {
      this._leadId = null
      this._reelect()
    }
  }

  // ---------------------------------------------------------------------------
  // Delta publishing
  // ---------------------------------------------------------------------------

  /** Queue deltas to be sent on the next tick flush */
  publishDeltas(deltas: DeltaSet): void {
    if (deltas.length > 0) this._pending.push(...deltas)
  }

  /** Send all pending deltas immediately (called by the tick interval) */
  flush(): void {
    if (this._pending.length === 0 || !this._sendFn) return

    const payload = encodeDeltaPayload(this.id, this._pending)
    this._pending = []

    const msg: NetMessage = {
      type: MessageType.DeltaUpdate,
      flags: MessageFlag.None,
      seq: this._nextSeq(),
      ack: this._ack,
      payload,
    }

    if (this.isLead) {
      // Lead fans out to all group peers
      for (const peerId of this._peers.keys()) {
        this._sendFn(peerId, msg)
      }
    } else if (this._leadId !== null) {
      // Non-lead sends only to the lead
      this._sendFn(this._leadId, msg)
    }
  }

  // ---------------------------------------------------------------------------
  // Inbound message dispatch
  // ---------------------------------------------------------------------------

  handleMessage(msg: NetMessage, fromPeer: PeerId): void {
    const state = this._peers.get(fromPeer)
    if (state) state.lastSeenAt = Date.now()
    this._ack = msg.seq

    switch (msg.type) {
      case MessageType.DeltaUpdate:
        this._onDeltaUpdate(msg, fromPeer)
        break
      case MessageType.FullSync:
        this._onFullSync(msg, fromPeer)
        break
      case MessageType.LeadClaim:
        this._onLeadClaim(msg)
        break
    }
  }

  // ---------------------------------------------------------------------------
  // Handler registration
  // ---------------------------------------------------------------------------

  onDelta(handler: DeltaHandler): () => void {
    this._deltaHandlers.add(handler)
    return () => this._deltaHandlers.delete(handler)
  }

  // ---------------------------------------------------------------------------
  // Tick control
  // ---------------------------------------------------------------------------

  startTick(): void {
    if (this._tickHandle !== null) return
    this._tickHandle = setInterval(() => this.flush(), this._config.tickRateMs)
  }

  stopTick(): void {
    if (this._tickHandle !== null) {
      clearInterval(this._tickHandle)
      this._tickHandle = null
    }
  }

  dispose(): void {
    this.stopTick()
    this._deltaHandlers.clear()
    this._peers.clear()
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _reelect(): void {
    if (this._peers.size === 0) {
      // Only local peer remains — we are the lead by default
      this._leadId = this._localPeerId
      return
    }
    const candidates = [this._localPeerId, ...this._peers.keys()]
    const newLead = this._elector.electLead(this.id, candidates)
    if (newLead !== this._leadId) {
      this._leadId = newLead
      if (newLead === this._localPeerId) {
        this._broadcastLeadClaim()
      }
    }
  }

  private _broadcastLeadClaim(): void {
    if (!this._sendFn) return
    const payload = encodeJson({ groupId: this.id, leadId: this._localPeerId })
    const msg: NetMessage = {
      type: MessageType.LeadClaim,
      flags: MessageFlag.Reliable,
      seq: this._nextSeq(),
      ack: this._ack,
      payload,
    }
    for (const peerId of this._peers.keys()) {
      this._sendFn(peerId, msg)
    }
  }

  private _onDeltaUpdate(msg: NetMessage, fromPeer: PeerId): void {
    let groupId: string
    let deltas: DeltaSet
    try {
      ;({ groupId, deltas } = decodeDeltaPayload(msg.payload))
    } catch { return }
    if (groupId !== this.id) return

    if (this.isLead && this._sendFn) {
      // Fan out to all peers except the sender
      for (const peerId of this._peers.keys()) {
        if (peerId !== fromPeer) this._sendFn(peerId, msg)
      }
    }

    for (const h of this._deltaHandlers) h(deltas, this.id, fromPeer)
  }

  private _onFullSync(msg: NetMessage, fromPeer: PeerId): void {
    let groupId: string
    let deltas: DeltaSet
    try {
      ;({ groupId, deltas } = decodeDeltaPayload(msg.payload))
    } catch { return }
    if (groupId !== this.id) return
    // Full sync is never re-broadcast — it is a directed one-shot to this peer
    for (const h of this._deltaHandlers) h(deltas, this.id, fromPeer)
  }

  private _onLeadClaim(msg: NetMessage): void {
    try {
      const { groupId, leadId } = decodeJson(msg.payload)
      if (groupId !== this.id || typeof leadId !== 'string') return
      // Accept claim only if the claimed lead is a known peer
      if (this._peers.has(leadId) || leadId === this._localPeerId) {
        this._leadId = leadId
        for (const [pid, state] of this._peers) state.isLead = pid === leadId
      }
    } catch { /* malformed */ }
  }

  private _nextSeq(): number {
    return (this._seq = (this._seq + 1) & 0xffff)
  }
}
