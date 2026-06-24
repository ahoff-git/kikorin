/**
 * Integration tests for @kikorin/netcode
 *
 * Uses an in-memory mock transport (MockNet) that routes messages synchronously,
 * so assertions can be made immediately after flush() without awaiting timers.
 *
 * Groups are created with tickRateMs: 9_999_999 to disable the auto-flush interval;
 * tests call group.flush() directly to control exactly when sends happen.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { PeerJSDataConnection, PeerJSPeer } from '../connection-pool'
import { InterestGroup } from '../interest-group'
import { PeerNet } from '../peer-net'
import type { ComponentSchema, DeltaSet } from '../types'

// ---------------------------------------------------------------------------
// In-memory mock PeerJS transport
//
// Synchronous delivery: MockConn.send() immediately calls data handlers on the
// partner so the full chain (send → route → decode → handler) happens in one
// call stack, making every assertion deterministic.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EvHandler = (...args: any[]) => void

function makeEvMap() {
  const m = new Map<string, EvHandler[]>()
  return {
    on(ev: string, cb: EvHandler) {
      let arr = m.get(ev)
      if (!arr) { arr = []; m.set(ev, arr) }
      arr.push(cb)
    },
    emit(ev: string, ...args: unknown[]) {
      for (const cb of m.get(ev) ?? []) cb(...args)
    },
  }
}

class MockConn implements PeerJSDataConnection {
  readonly peer: string
  open = false
  _partner: MockConn | null = null
  private _ev = makeEvMap()

  constructor(remotePeerId: string) { this.peer = remotePeerId }

  on(event: 'data',  cb: (data: unknown) => void): void
  on(event: 'open',  cb: () => void): void
  on(event: 'close', cb: () => void): void
  on(event: 'error', cb: (err: Error) => void): void
  on(event: string,  cb: EvHandler): void {
    this._ev.on(event, cb)
  }

  send(data: ArrayBuffer | Uint8Array): void {
    if (!this._partner?.open) return
    const buf: ArrayBuffer = data instanceof Uint8Array
      ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
      : data
    this._partner._ev.emit('data', buf)
  }

  close(): void {
    if (!this.open) return
    this.open = false
    this._ev.emit('close')
    if (this._partner) {
      const p = this._partner
      this._partner = null
      p._partner = null
      p.open = false
      p._ev.emit('close')
    }
  }

  _open(): void { this.open = true; this._ev.emit('open') }
}

class MockPeerNode implements PeerJSPeer {
  readonly id: string
  private _net: MockNet
  private _ev = makeEvMap()

  constructor(id: string, net: MockNet) { this.id = id; this._net = net }

  on(event: 'connection', cb: (conn: PeerJSDataConnection) => void): void
  on(event: 'open',  cb: (id: string) => void): void
  on(event: 'error', cb: (err: Error) => void): void
  on(event: 'close', cb: () => void): void
  on(event: string,  cb: EvHandler): void { this._ev.on(event, cb) }
  connect(peerId: string): PeerJSDataConnection { return this._net._connect(this.id, peerId) }
  destroy(): void { this._net._remove(this.id) }
  _emit(ev: string, ...args: unknown[]): void { this._ev.emit(ev, ...args) }
}

class MockNet {
  private _nodes = new Map<string, MockPeerNode>()

  register(id: string): MockPeerNode {
    const node = new MockPeerNode(id, this)
    this._nodes.set(id, node)
    return node
  }

  /** Simulate a hard network drop for a peer — closes all connections to it */
  hardDrop(id: string): void { this._nodes.delete(id) }

  _connect(fromId: string, toId: string): MockConn {
    const to = this._nodes.get(toId)
    if (!to) throw new Error(`MockNet: unknown peer "${toId}"`)
    const cA = new MockConn(toId)
    const cB = new MockConn(fromId)
    cA._partner = cB
    cB._partner = cA
    // Notify the receiving peer synchronously so ConnectionPool._registerIncoming
    // wires up the 'open' handler on cB before the microtask fires.
    to._emit('connection', cB)
    // Open both ends on the next microtask — ConnectionPool.connect() registers
    // its own 'open' handler on cA AFTER this _connect() call returns, so we must
    // defer the event to let that handler be installed first.
    queueMicrotask(() => { cA._open(); cB._open() })
    return cA
  }

  _remove(id: string): void { this._nodes.delete(id) }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface TestPeer {
  id: string
  net: PeerNet
}

function makePeer(id: string, mockNet: MockNet): TestPeer {
  const net = new PeerNet({ peerId: id })
  net.attachPeer(mockNet.register(id))
  return { id, net }
}

async function connectAll(peers: TestPeer[]): Promise<void> {
  for (let i = 0; i < peers.length; i++) {
    for (let j = i + 1; j < peers.length; j++) {
      await peers[i].net.connectPeer(peers[j].id)
    }
  }
}

/**
 * Create the same group on every peer and cross-wire memberships directly
 * (bypasses Subscribe wire protocol — use the wire-protocol suite for that).
 * Returns the group instances in the same order as `peers`.
 */
function joinGroupDirect(groupId: string, peers: TestPeer[]): InterestGroup[] {
  const groups = peers.map(p => p.net.createGroup({ id: groupId, tickRateMs: 9_999_999 }))
  for (let i = 0; i < peers.length; i++) {
    for (let j = 0; j < peers.length; j++) {
      if (i !== j) groups[i].addPeer(peers[j].id)
    }
  }
  return groups
}

function makeSchema(
  componentId: number,
  fieldCount: number,
): { schema: ComponentSchema; arrays: Float32Array[] } {
  const arrays = Array.from({ length: fieldCount }, () => new Float32Array(256))
  return {
    arrays,
    schema: {
      id: componentId,
      name: `C${componentId}`,
      fields: arrays.map((arr, fi) => ({ id: fi, name: `f${fi}`, array: arr })),
    },
  }
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('netcode integration', () => {
  let mockNet: MockNet
  let allPeers: TestPeer[] = []

  beforeEach(() => {
    mockNet = new MockNet()
    allPeers = []
  })

  afterEach(() => {
    for (const p of allPeers) p.net.dispose()
  })

  // -------------------------------------------------------------------------
  // Lead election
  // -------------------------------------------------------------------------

  describe('lead election', () => {
    it('min-id: lexicographically smallest peer is always elected lead', async () => {
      const [pA, pB, pC] = ['peer-alice', 'peer-bob', 'peer-carol'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB, pC]
      await connectAll(allPeers)

      const [gA, gB, gC] = joinGroupDirect('g', allPeers)

      expect(gA.leadId).toBe('peer-alice')
      expect(gB.leadId).toBe('peer-alice')
      expect(gC.leadId).toBe('peer-alice')
      expect(gA.isLead).toBe(true)
      expect(gB.isLead).toBe(false)
      expect(gC.isLead).toBe(false)
    })

    it('hash-ring: distributes leadership across multiple groups', async () => {
      const peers = ['peer-x', 'peer-y', 'peer-z'].map(id => makePeer(id, mockNet))
      allPeers = peers
      await connectAll(allPeers)

      const GROUP_IDS = [
        'zone-north', 'zone-south', 'zone-east', 'zone-west',
        'sector:01', 'sector:02', 'sector:03', 'sector:04',
        'room/100', 'room/200', 'room/300',
      ]

      const leaders = new Set<string>()
      for (const gid of GROUP_IDS) {
        const g = peers[0].net.createGroup({ id: gid, electionStrategy: 'hash-ring', tickRateMs: 9_999_999 })
        g.addPeer('peer-y')
        g.addPeer('peer-z')
        if (g.leadId) leaders.add(g.leadId)
      }

      // 11 groups across 3 peers with 20 virtual nodes each — at least 2 distinct leads
      expect(leaders.size).toBeGreaterThanOrEqual(2)
    })

    it('load-balanced: prefers peer with lowest weighted load', async () => {
      const peers = ['peer-a', 'peer-b'].map(id => makePeer(id, mockNet))
      allPeers = peers
      await connectAll(allPeers)

      const g = peers[0].net.createGroup({ id: 'load', electionStrategy: 'load-balanced', tickRateMs: 9_999_999 })
      g.addPeer('peer-b')

      // Report heavy load for the current lead; peer-b is unknown (score=0)
      const elector = (g as unknown as { _elector: import('../lead-election').LeadElector })._elector
      elector.updateLoadInfo({ peerId: g.leadId!, connectionCount: 20, leadGroupCount: 10 })
      elector.updateLoadInfo({ peerId: 'peer-b', connectionCount: 1, leadGroupCount: 0 })

      // Force re-election with updated info
      g.addPeer('peer-b') // idempotent — triggers _reelect
      const heavy = g.leadId === 'peer-a' ? 'peer-a' : 'peer-b'
      const light = heavy === 'peer-a' ? 'peer-b' : 'peer-a'
      elector.updateLoadInfo({ peerId: heavy, connectionCount: 30, leadGroupCount: 15 })
      elector.updateLoadInfo({ peerId: light, connectionCount: 0, leadGroupCount: 0 })

      // Election is lazy (runs on addPeer); trigger it by removing and re-adding
      g.removePeer(light === 'peer-a' ? 'peer-b' : 'peer-a')
      g.addPeer(light === 'peer-a' ? 'peer-b' : 'peer-a')

      expect(g.leadId).toBe(light)
    })
  })

  // -------------------------------------------------------------------------
  // Delta routing
  // -------------------------------------------------------------------------

  describe('delta routing through lead', () => {
    it('non-lead delta reaches all other group peers via lead fan-out', async () => {
      const [pA, pB, pC] = ['peer-alice', 'peer-bob', 'peer-carol'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB, pC]
      await connectAll(allPeers)

      const { schema, arrays } = makeSchema(0, 3)
      for (const p of allPeers) p.net.registerComponent(schema)

      const [gA, gB, gC] = joinGroupDirect('movement', allPeers)
      const receivedByA: DeltaSet[] = []
      const receivedByB: DeltaSet[] = []
      gA.onDelta(d => receivedByA.push(d))
      gB.onDelta(d => receivedByB.push(d))

      // peer-carol (non-lead) sends position update for entity 10
      arrays[0][10] = 5.5
      arrays[1][10] = -3.0
      pC.net.markEntityDirty(10)
      pC.net.flushGroupDeltas('movement', [10])
      gC.flush() // sends to lead (peer-alice); lead fans out synchronously

      expect(receivedByA).toHaveLength(1)
      expect(receivedByB).toHaveLength(1)
      expect(receivedByA[0].find(d => d.entityId === 10 && d.fieldId === 0)!.value).toBeCloseTo(5.5, 3)
      expect(receivedByB[0].find(d => d.entityId === 10 && d.fieldId === 1)!.value).toBeCloseTo(-3.0, 3)
    })

    it("lead's own deltas broadcast to all group peers", async () => {
      const [pA, pB, pC] = ['peer-alice', 'peer-bob', 'peer-carol'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB, pC]
      await connectAll(allPeers)

      const { schema, arrays } = makeSchema(0, 2)
      for (const p of allPeers) p.net.registerComponent(schema)

      const [gA, gB, gC] = joinGroupDirect('physics', allPeers)
      const receivedByB: DeltaSet[] = []
      const receivedByC: DeltaSet[] = []
      gB.onDelta(d => receivedByB.push(d))
      gC.onDelta(d => receivedByC.push(d))

      // peer-alice IS the lead
      arrays[0][7] = 99
      pA.net.markEntityDirty(7)
      pA.net.flushGroupDeltas('physics', [7])
      gA.flush()

      expect(receivedByB).toHaveLength(1)
      expect(receivedByC).toHaveLength(1)
      expect(receivedByB[0][0].entityId).toBe(7)
      expect(receivedByC[0][0].value).toBeCloseTo(99, 1)
    })

    it('sender does not receive its own delta echoed back', async () => {
      const [pA, pB] = ['peer-alice', 'peer-bob'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB]
      await connectAll(allPeers)

      const { schema, arrays } = makeSchema(0, 1)
      for (const p of allPeers) p.net.registerComponent(schema)

      const [, gB] = joinGroupDirect('echo', allPeers)
      const receivedByB: DeltaSet[] = []
      gB.onDelta(d => receivedByB.push(d))

      arrays[0][3] = 42
      pB.net.markEntityDirty(3)
      pB.net.flushGroupDeltas('echo', [3])
      gB.flush() // sends to lead (peer-alice); alice fans out excluding peer-bob

      expect(receivedByB).toHaveLength(0)
    })

    it('multiple entities in a single flush are all delivered', async () => {
      const [pA, pB] = ['peer-alice', 'peer-bob'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB]
      await connectAll(allPeers)

      const { schema, arrays } = makeSchema(0, 1)
      for (const p of allPeers) p.net.registerComponent(schema)

      const [gA, gB] = joinGroupDirect('batch', allPeers)
      const received: DeltaSet[] = []
      gB.onDelta(d => received.push(d))

      for (let eid = 1; eid <= 10; eid++) {
        arrays[0][eid] = eid * 2
        pA.net.markEntityDirty(eid)
      }
      pA.net.flushGroupDeltas('batch', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
      gA.flush()

      const allDeltas = received.flat()
      expect(allDeltas).toHaveLength(10)
      for (let eid = 1; eid <= 10; eid++) {
        expect(allDeltas.find(d => d.entityId === eid)!.value).toBeCloseTo(eid * 2, 1)
      }
    })
  })

  // -------------------------------------------------------------------------
  // Change tracking — minimal delta sets
  // -------------------------------------------------------------------------

  describe('change tracking', () => {
    it('only sends fields that changed since the last flush', async () => {
      const [pA, pB] = ['peer-alice', 'peer-bob'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB]
      await connectAll(allPeers)

      const { schema, arrays } = makeSchema(0, 4)
      for (const p of allPeers) p.net.registerComponent(schema)

      const [gA, gB] = joinGroupDirect('partial', allPeers)
      const received: DeltaSet[] = []
      gB.onDelta(d => received.push(d))

      // Flush once at zero-values to seed the snapshot
      pA.net.markEntityDirty(1)
      pA.net.flushGroupDeltas('partial', [1])
      gA.flush()
      received.length = 0

      // Now change fields 0 and 2 only
      arrays[0][1] = 10
      arrays[2][1] = 30
      pA.net.markEntityDirty(1)
      pA.net.flushGroupDeltas('partial', [1])
      gA.flush()

      expect(received).toHaveLength(1)
      const firstFieldIds = received[0].filter(d => d.entityId === 1).map(d => d.fieldId).sort()
      expect(firstFieldIds).toEqual([0, 2])

      // Second flush: change only field 3
      arrays[3][1] = 40
      pA.net.markEntityDirty(1)
      pA.net.flushGroupDeltas('partial', [1])
      gA.flush()

      expect(received).toHaveLength(2)
      const secondFieldIds = received[1].filter(d => d.entityId === 1).map(d => d.fieldId)
      expect(secondFieldIds).toEqual([3])
    })

    it('no delta emitted when values are unchanged between flushes', async () => {
      const [pA, pB] = ['peer-alice', 'peer-bob'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB]
      await connectAll(allPeers)

      const { schema, arrays } = makeSchema(0, 2)
      for (const p of allPeers) p.net.registerComponent(schema)

      const [gA, gB] = joinGroupDirect('nochange', allPeers)
      const received: DeltaSet[] = []
      gB.onDelta(d => received.push(d))

      // Establish snapshot
      arrays[0][5] = 7
      pA.net.markEntityDirty(5)
      pA.net.flushGroupDeltas('nochange', [5])
      gA.flush()
      received.length = 0

      // Mark dirty again without changing values
      pA.net.markEntityDirty(5)
      pA.net.flushGroupDeltas('nochange', [5])
      gA.flush()

      expect(received).toHaveLength(0)
    })

    it('full sync sends all registered fields regardless of dirty state', async () => {
      const [pA, pB] = ['peer-alice', 'peer-bob'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB]
      await connectAll(allPeers)

      const { schema, arrays } = makeSchema(0, 3)
      pA.net.registerComponent(schema)

      const [, gB] = joinGroupDirect('fullsync', allPeers)
      const received: DeltaSet[] = []
      gB.onDelta(d => received.push(d))

      // Set values without marking dirty or flushing
      arrays[0][2] = 1; arrays[1][2] = 2; arrays[2][2] = 3
      pA.net.sendFullSync('fullsync', 'peer-bob', [2])

      expect(received).toHaveLength(1)
      const fields = received[0].filter(d => d.entityId === 2)
      expect(fields).toHaveLength(3)
      expect(fields.find(d => d.fieldId === 0)!.value).toBeCloseTo(1, 3)
      expect(fields.find(d => d.fieldId === 1)!.value).toBeCloseTo(2, 3)
      expect(fields.find(d => d.fieldId === 2)!.value).toBeCloseTo(3, 3)
    })

    it('dirty state is scoped — clean entities are skipped even in same flush call', async () => {
      const [pA, pB] = ['peer-alice', 'peer-bob'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB]
      await connectAll(allPeers)

      const { schema, arrays } = makeSchema(0, 1)
      for (const p of allPeers) p.net.registerComponent(schema)

      const [gA, gB] = joinGroupDirect('scope', allPeers)
      const received: DeltaSet[] = []
      gB.onDelta(d => received.push(d))

      // Only mark entity 5 dirty; entity 6 has a value but is clean
      arrays[0][5] = 99
      arrays[0][6] = 88
      pA.net.markEntityDirty(5)
      pA.net.flushGroupDeltas('scope', [5, 6])
      gA.flush()

      const allDeltas = received.flat()
      expect(allDeltas.some(d => d.entityId === 5)).toBe(true)
      expect(allDeltas.some(d => d.entityId === 6)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // Disconnect and re-election
  // -------------------------------------------------------------------------

  describe('disconnect and re-election', () => {
    it('re-elects when lead is explicitly disconnected', async () => {
      const [pA, pB, pC] = ['peer-alice', 'peer-bob', 'peer-carol'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB, pC]
      await connectAll(allPeers)

      const [, gB, gC] = joinGroupDirect('reelect', allPeers)

      expect(gB.leadId).toBe('peer-alice')
      expect(gC.leadId).toBe('peer-alice')

      // Simulate clean disconnect of the lead
      pB.net.disconnectPeer('peer-alice')
      pC.net.disconnectPeer('peer-alice')

      // peer-bob < peer-carol → peer-bob becomes new lead
      expect(gB.leadId).toBe('peer-bob')
      expect(gC.leadId).toBe('peer-bob')
      expect(gB.isLead).toBe(true)
    })

    it('re-elects when lead connection drops (onDisconnect hook)', async () => {
      const [pA, pB, pC] = ['peer-alice', 'peer-bob', 'peer-carol'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB, pC]
      await connectAll(allPeers)

      const [, gB, gC] = joinGroupDirect('drop', allPeers)
      expect(gB.leadId).toBe('peer-alice')

      // Simulate hard connection close between alice↔bob and alice↔carol
      // The ConnectionPool onDisconnect hook removes alice from all groups on B and C
      const poolB = (pB.net as unknown as { _pool: { _conns: Map<string, { conn: MockConn }> } })._pool
      poolB._conns.get('peer-alice')?.conn.close()

      const poolC = (pC.net as unknown as { _pool: { _conns: Map<string, { conn: MockConn }> } })._pool
      poolC._conns.get('peer-alice')?.conn.close()

      expect(gB.leadId).toBe('peer-bob')
      expect(gC.leadId).toBe('peer-bob')
    })

    it('messages continue flowing through new lead after re-election', async () => {
      const [pA, pB, pC] = ['peer-alice', 'peer-bob', 'peer-carol'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB, pC]
      await connectAll(allPeers)

      const { schema, arrays } = makeSchema(0, 1)
      for (const p of allPeers) p.net.registerComponent(schema)

      const [, gB, gC] = joinGroupDirect('flow', allPeers)
      const receivedByB: DeltaSet[] = []
      gB.onDelta(d => receivedByB.push(d))

      // Disconnect lead (peer-alice)
      pB.net.disconnectPeer('peer-alice')
      pC.net.disconnectPeer('peer-alice')
      // peer-bob is now lead

      // peer-carol sends → new lead (peer-bob) → peer-bob fans out
      arrays[0][8] = 77
      pC.net.markEntityDirty(8)
      pC.net.flushGroupDeltas('flow', [8])
      gC.flush()

      expect(receivedByB).toHaveLength(1)
      expect(receivedByB[0][0].entityId).toBe(8)
      expect(receivedByB[0][0].value).toBeCloseTo(77, 1)
    })

    it('lone peer becomes its own lead when all others disconnect', async () => {
      const [pA, pB] = ['peer-alice', 'peer-bob'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB]
      await connectAll(allPeers)

      const [, gB] = joinGroupDirect('lone', allPeers)
      expect(gB.leadId).toBe('peer-alice')

      pB.net.disconnectPeer('peer-alice')

      expect(gB.leadId).toBe('peer-bob')
      expect(gB.isLead).toBe(true)
      expect(gB.peerCount).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Multiple groups
  // -------------------------------------------------------------------------

  describe('multiple groups', () => {
    it('deltas in one group do not leak into another', async () => {
      const [pA, pB, pC] = ['peer-alice', 'peer-bob', 'peer-carol'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB, pC]
      await connectAll(allPeers)

      const { schema, arrays } = makeSchema(0, 1)
      for (const p of allPeers) p.net.registerComponent(schema)

      // group1: A ↔ B;  group2: B ↔ C
      const gA1 = pA.net.createGroup({ id: 'group1', tickRateMs: 9_999_999 })
      const gB1 = pB.net.createGroup({ id: 'group1', tickRateMs: 9_999_999 })
      gA1.addPeer('peer-bob'); gB1.addPeer('peer-alice')

      const gB2 = pB.net.createGroup({ id: 'group2', tickRateMs: 9_999_999 })
      const gC2 = pC.net.createGroup({ id: 'group2', tickRateMs: 9_999_999 })
      gB2.addPeer('peer-carol'); gC2.addPeer('peer-bob')

      const inGroup1: DeltaSet[] = []
      const inGroup2: DeltaSet[] = []
      gB1.onDelta(d => inGroup1.push(d))
      gB2.onDelta(d => inGroup2.push(d))

      // peer-carol sends in group2
      arrays[0][20] = 55
      pC.net.markEntityDirty(20)
      pC.net.flushGroupDeltas('group2', [20])
      gC2.flush()

      expect(inGroup2).toHaveLength(1)
      expect(inGroup1).toHaveLength(0)
    })

    it('a peer in multiple groups receives independent delta streams', async () => {
      const [pA, pB, pC] = ['peer-alice', 'peer-bob', 'peer-carol'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB, pC]
      await connectAll(allPeers)

      const { schema: sPos, arrays: aPos } = makeSchema(0, 1)
      const { schema: sVel, arrays: aVel } = makeSchema(1, 1)
      for (const p of allPeers) {
        p.net.registerComponent(sPos)
        p.net.registerComponent(sVel)
      }

      // peer-bob is in both groups
      const gA_pos = pA.net.createGroup({ id: 'pos', tickRateMs: 9_999_999 })
      const gB_pos = pB.net.createGroup({ id: 'pos', tickRateMs: 9_999_999 })
      gA_pos.addPeer('peer-bob'); gB_pos.addPeer('peer-alice')

      const gC_vel = pC.net.createGroup({ id: 'vel', tickRateMs: 9_999_999 })
      const gB_vel = pB.net.createGroup({ id: 'vel', tickRateMs: 9_999_999 })
      gC_vel.addPeer('peer-bob'); gB_vel.addPeer('peer-carol')

      const posRx: DeltaSet[] = []
      const velRx: DeltaSet[] = []
      gB_pos.onDelta(d => posRx.push(d))
      gB_vel.onDelta(d => velRx.push(d))

      aPos[0][5] = 1
      pA.net.markEntityDirty(5)
      pA.net.flushGroupDeltas('pos', [5])
      gA_pos.flush()

      aVel[0][5] = 2
      pC.net.markEntityDirty(5)
      pC.net.flushGroupDeltas('vel', [5])
      gC_vel.flush()

      expect(posRx).toHaveLength(1)
      expect(velRx).toHaveLength(1)
      // Each delta batch may include multiple components (tracker covers all registered);
      // assert that the expected component appears somewhere in the received set
      expect(posRx[0].some(d => d.componentId === 0)).toBe(true)
      expect(velRx[0].some(d => d.componentId === 1)).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Subscribe / Unsubscribe wire protocol
  // -------------------------------------------------------------------------

  describe('subscribe / unsubscribe wire protocol', () => {
    it('joinGroup sends Subscribe; remote peer adds local peer to its group', async () => {
      const [pA, pB] = ['peer-alice', 'peer-bob'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB]
      await connectAll(allPeers)

      pA.net.createGroup({ id: 'wire', tickRateMs: 9_999_999 })
      pB.net.createGroup({ id: 'wire', tickRateMs: 9_999_999 })

      // Subscribe message is sent synchronously via mock transport
      pA.net.joinGroup('wire', ['peer-bob'])

      const gB = pB.net.getGroup('wire')!
      expect(gB.peerIds.has('peer-alice')).toBe(true)
    })

    it('leaveGroup sends Unsubscribe; remote peer removes local peer from its group', async () => {
      const [pA, pB] = ['peer-alice', 'peer-bob'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB]
      await connectAll(allPeers)

      pA.net.createGroup({ id: 'leave', tickRateMs: 9_999_999 })
      pB.net.createGroup({ id: 'leave', tickRateMs: 9_999_999 })

      pA.net.joinGroup('leave', ['peer-bob'])
      expect(pB.net.getGroup('leave')!.peerIds.has('peer-alice')).toBe(true)

      pA.net.leaveGroup('leave')
      expect(pB.net.getGroup('leave')!.peerIds.has('peer-alice')).toBe(false)
    })

    it('both peers joining triggers bidirectional group membership', async () => {
      const [pA, pB] = ['peer-alice', 'peer-bob'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB]
      await connectAll(allPeers)

      pA.net.createGroup({ id: 'bidir', tickRateMs: 9_999_999 })
      pB.net.createGroup({ id: 'bidir', tickRateMs: 9_999_999 })

      pA.net.joinGroup('bidir', ['peer-bob'])
      pB.net.joinGroup('bidir', ['peer-alice'])

      expect(pA.net.getGroup('bidir')!.peerIds.has('peer-bob')).toBe(true)
      expect(pB.net.getGroup('bidir')!.peerIds.has('peer-alice')).toBe(true)
    })
  })

  // -------------------------------------------------------------------------
  // Direct messages — Ping / Pong RTT
  // -------------------------------------------------------------------------

  describe('ping / pong RTT', () => {
    it('ping triggers pong and the EMA updates rttMs', async () => {
      const [pA, pB] = ['peer-alice', 'peer-bob'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB]
      await connectAll(allPeers)

      const before = pA.net.rttMs
      pA.net.ping('peer-bob') // synchronous mock: pong fires immediately
      const after = pA.net.rttMs

      expect(typeof after).toBe('number')
      expect(Number.isFinite(after)).toBe(true)
      // EMA moves toward the measured RTT; with synchronous delivery RTT ≈ 0
      // so new EMA < initial EMA (50ms default)
      expect(after).toBeLessThan(before)
    })

    it('multiple pings converge rttMs toward zero in the mock', async () => {
      const [pA, pB] = ['peer-alice', 'peer-bob'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB]
      await connectAll(allPeers)

      // With alpha=0.125 and initial=50ms: 50 * 0.875^n converges toward 0.
      // After 40 pings with ~0ms RTT: 50 * 0.875^40 ≈ 0.24ms < 1ms.
      for (let i = 0; i < 40; i++) pA.net.ping('peer-bob')
      expect(pA.net.rttMs).toBeLessThan(1)
    })
  })

  // -------------------------------------------------------------------------
  // Entity invalidation
  // -------------------------------------------------------------------------

  describe('entity invalidation', () => {
    it('invalidated entity re-emits all fields on next flush even if values unchanged', async () => {
      const [pA, pB] = ['peer-alice', 'peer-bob'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB]
      await connectAll(allPeers)

      const { schema, arrays } = makeSchema(0, 3)
      for (const p of allPeers) p.net.registerComponent(schema)

      const [gA, gB] = joinGroupDirect('invalidate', allPeers)
      const received: DeltaSet[] = []
      gB.onDelta(d => received.push(d))

      // Establish snapshot
      arrays[0][9] = 1; arrays[1][9] = 2; arrays[2][9] = 3
      pA.net.markEntityDirty(9)
      pA.net.flushGroupDeltas('invalidate', [9])
      gA.flush()
      received.length = 0 // reset

      // Invalidate — same values, but snapshot is cleared → all 3 fields re-emit
      pA.net.invalidateEntity(9)
      pA.net.flushGroupDeltas('invalidate', [9])
      gA.flush()

      expect(received).toHaveLength(1)
      expect(received[0].filter(d => d.entityId === 9)).toHaveLength(3)
    })
  })

  // -------------------------------------------------------------------------
  // PeerList — mesh introduction protocol
  // -------------------------------------------------------------------------

  describe('peer list / mesh introduction', () => {
    it('sendPeerList delivers peer ids to the receiver via onPeerList', async () => {
      const [pA, pB] = ['peer-alice', 'peer-bob'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB]
      await connectAll(allPeers)

      const received: { peers: string[]; from: string }[] = []
      pB.net.onPeerList((peers, from) => received.push({ peers, from }))

      pA.net.sendPeerList('peer-bob', ['peer-carol', 'peer-dave'])

      expect(received).toHaveLength(1)
      expect(received[0].from).toBe('peer-alice')
      expect(received[0].peers).toEqual(['peer-carol', 'peer-dave'])
    })

    it('sendPeerList with empty list is a no-op (no message sent)', async () => {
      const [pA, pB] = ['peer-alice', 'peer-bob'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB]
      await connectAll(allPeers)

      const received: string[][] = []
      pB.net.onPeerList(peers => received.push(peers))

      pA.net.sendPeerList('peer-bob', [])

      expect(received).toHaveLength(0)
    })

    it('receiver filters its own id out of incoming peer lists', async () => {
      const [pA, pB] = ['peer-alice', 'peer-bob'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB]
      await connectAll(allPeers)

      const received: string[][] = []
      pB.net.onPeerList(peers => received.push(peers))

      // alice erroneously includes bob's own id in the list
      pA.net.sendPeerList('peer-bob', ['peer-bob', 'peer-carol'])

      expect(received).toHaveLength(1)
      expect(received[0]).toEqual(['peer-carol'])
    })

    it('onPeerList unsubscribe stops future deliveries', async () => {
      const [pA, pB] = ['peer-alice', 'peer-bob'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB]
      await connectAll(allPeers)

      const received: string[][] = []
      const unsub = pB.net.onPeerList(peers => received.push(peers))
      unsub()

      pA.net.sendPeerList('peer-bob', ['peer-carol'])

      expect(received).toHaveLength(0)
    })

    it('multiple onPeerList handlers all fire', async () => {
      const [pA, pB] = ['peer-alice', 'peer-bob'].map(id => makePeer(id, mockNet))
      allPeers = [pA, pB]
      await connectAll(allPeers)

      const calls: number[] = []
      pB.net.onPeerList(() => calls.push(1))
      pB.net.onPeerList(() => calls.push(2))

      pA.net.sendPeerList('peer-bob', ['peer-carol'])

      expect(calls).toEqual([1, 2])
    })
  })

  // -------------------------------------------------------------------------
  // Large-scale stress
  // -------------------------------------------------------------------------

  describe('stress', () => {
    it('5-peer group: deltas from any non-lead reach all other peers', async () => {
      const peerIds = ['peer-aa', 'peer-bb', 'peer-cc', 'peer-dd', 'peer-ee']
      const peers = peerIds.map(id => makePeer(id, mockNet))
      allPeers = peers
      await connectAll(allPeers)

      const { schema, arrays } = makeSchema(0, 1)
      for (const p of allPeers) p.net.registerComponent(schema)

      const groups = joinGroupDirect('stress', allPeers)
      const lead = groups[0].leadId!
      const nonLead = peers.find(p => p.id !== lead)!
      const nonLeadGroup = groups[peers.indexOf(nonLead)]

      // Track who receives the delta
      const received = new Map<string, number>()
      for (let i = 0; i < peers.length; i++) {
        const pid = peers[i].id
        groups[i].onDelta(() => received.set(pid, (received.get(pid) ?? 0) + 1))
      }

      arrays[0][100] = 42
      nonLead.net.markEntityDirty(100)
      nonLead.net.flushGroupDeltas('stress', [100])
      nonLeadGroup.flush()

      // Every peer except the sender should receive it
      for (const p of peers) {
        if (p.id === nonLead.id) {
          expect(received.get(p.id) ?? 0).toBe(0) // no self-echo
        } else {
          expect(received.get(p.id) ?? 0).toBe(1)
        }
      }
    })
  })
})
