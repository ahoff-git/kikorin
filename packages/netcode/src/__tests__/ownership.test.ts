/**
 * Ownership / bullet-sharing tests for the netcode layer.
 *
 * Each test runs the full round-trip:
 *   P1 writes to its world arrays → marks dirty → flushes
 *   → delta arrives at P2 → P2 applies values to its own world arrays
 *   → assert P2's arrays now match P1's arrays
 *
 * This mirrors what useNetworking.ts does in onGroupDelta: decode each field
 * and write it into the local ECS component arrays.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ComponentSchema, DeltaSet } from '../types'
import { connectAll, makePeer, MockNetwork, type TestPeer } from './mock-peer'

const POSITION_COMPONENT_ID   = 0
const ROTATION_COMPONENT_ID   = 1
const PROJECTILE_COMPONENT_ID = 2

const GROUP_ID = 'world'

// ---------------------------------------------------------------------------
// Per-peer world arrays (simulates two separate ECS instances)
// ---------------------------------------------------------------------------

interface WorldArrays {
  position:   { x: Float32Array; y: Float32Array; z: Float32Array }
  rotation:   { yaw: Float32Array; pitch: Float32Array }
  projectile: Int8Array
}

function makeWorldArrays(size = 256): WorldArrays {
  return {
    position: {
      x: new Float32Array(size),
      y: new Float32Array(size),
      z: new Float32Array(size),
    },
    rotation: {
      yaw:   new Float32Array(size),
      pitch: new Float32Array(size),
    },
    projectile: new Int8Array(size),
  }
}

function makeSchemas(w: WorldArrays): ComponentSchema[] {
  return [
    {
      id: POSITION_COMPONENT_ID,
      name: 'Position',
      fields: [
        { id: 0, name: 'x', array: w.position.x },
        { id: 1, name: 'y', array: w.position.y },
        { id: 2, name: 'z', array: w.position.z },
      ],
    },
    {
      id: ROTATION_COMPONENT_ID,
      name: 'Rotation',
      fields: [
        { id: 0, name: 'yaw',   array: w.rotation.yaw   },
        { id: 1, name: 'pitch', array: w.rotation.pitch },
      ],
    },
    {
      id: PROJECTILE_COMPONENT_ID,
      name: 'Projectile',
      fields: [{ id: 0, name: 'flag', array: w.projectile }],
    },
  ]
}

/** Apply an incoming delta batch to a world — mirrors onGroupDelta in useNetworking.ts. */
function applyDeltas(deltas: DeltaSet, world: WorldArrays): void {
  for (const d of deltas) {
    const eid = d.entityId
    if (d.componentId === POSITION_COMPONENT_ID) {
      if (d.fieldId === 0) world.position.x[eid] = d.value
      if (d.fieldId === 1) world.position.y[eid] = d.value
      if (d.fieldId === 2) world.position.z[eid] = d.value
    } else if (d.componentId === ROTATION_COMPONENT_ID) {
      if (d.fieldId === 0) world.rotation.yaw[eid]   = d.value
      if (d.fieldId === 1) world.rotation.pitch[eid] = d.value
    } else if (d.componentId === PROJECTILE_COMPONENT_ID) {
      if (d.fieldId === 0) world.projectile[eid] = d.value
    }
  }
}

// Disable the auto-flush interval; tests call group.flush() manually.
function createGroup(peer: TestPeer) {
  return peer.net.createGroup({ id: GROUP_ID, tickRateMs: 9_999_999 })
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('ownership: bullet sharing over netcode', () => {
  let network: MockNetwork
  let peers: TestPeer[]

  beforeEach(() => { network = new MockNetwork(); peers = [] })
  afterEach(() => { for (const p of peers) p.net.dispose() })

  // -------------------------------------------------------------------------
  // Projectile flag
  // -------------------------------------------------------------------------

  describe('projectile flag', () => {
    it('P2 world has projectile flag = 1 after receiving P1 bullet delta', async () => {
      const [pA, pB] = peers = [makePeer('p1', network), makePeer('p2', network)]
      await connectAll(peers)

      const w1 = makeWorldArrays()
      const w2 = makeWorldArrays()
      for (const s of makeSchemas(w1)) pA.net.registerComponent(s)
      for (const s of makeSchemas(w2)) pB.net.registerComponent(s)

      const gA = createGroup(pA)
      const gB = createGroup(pB)
      gA.addPeer('p2'); gB.addPeer('p1')

      gB.onDelta(d => applyDeltas(d, w2))

      const EID = 10
      w1.projectile[EID] = 1
      w1.position.x[EID] = 3; w1.position.y[EID] = 1; w1.position.z[EID] = -5

      pA.net.markEntityDirty(EID)
      pA.net.flushGroupDeltas(GROUP_ID, [EID])
      gA.flush()

      // P2's world should now reflect P1's projectile flag
      expect(w2.projectile[EID]).toBe(w1.projectile[EID])
    })

    it('P2 world has projectile flag = 0 for a non-projectile entity', async () => {
      const [pA, pB] = peers = [makePeer('p1', network), makePeer('p2', network)]
      await connectAll(peers)

      const w1 = makeWorldArrays()
      const w2 = makeWorldArrays()
      for (const s of makeSchemas(w1)) pA.net.registerComponent(s)
      for (const s of makeSchemas(w2)) pB.net.registerComponent(s)

      const gA = createGroup(pA)
      const gB = createGroup(pB)
      gA.addPeer('p2'); gB.addPeer('p1')

      gB.onDelta(d => applyDeltas(d, w2))

      const EID = 20
      // projectile flag stays 0 — this is an NPC
      w1.position.x[EID] = 5; w1.position.z[EID] = 2

      pA.net.sendFullSync(GROUP_ID, 'p2', [EID])

      expect(w2.projectile[EID]).toBe(0)
    })
  })

  // -------------------------------------------------------------------------
  // Position values match after sync
  // -------------------------------------------------------------------------

  describe('position values match across peers', () => {
    it('P2 position equals P1 position after the first bullet delta', async () => {
      const [pA, pB] = peers = [makePeer('p1', network), makePeer('p2', network)]
      await connectAll(peers)

      const w1 = makeWorldArrays()
      const w2 = makeWorldArrays()
      for (const s of makeSchemas(w1)) pA.net.registerComponent(s)
      for (const s of makeSchemas(w2)) pB.net.registerComponent(s)

      const gA = createGroup(pA)
      const gB = createGroup(pB)
      gA.addPeer('p2'); gB.addPeer('p1')

      gB.onDelta(d => applyDeltas(d, w2))

      const EID = 5
      w1.projectile[EID] = 1
      w1.position.x[EID] = 10.5
      w1.position.y[EID] = 2.0
      w1.position.z[EID] = -8.25

      pA.net.markEntityDirty(EID)
      pA.net.flushGroupDeltas(GROUP_ID, [EID])
      gA.flush()

      expect(w2.position.x[EID]).toBeCloseTo(w1.position.x[EID], 3)
      expect(w2.position.y[EID]).toBeCloseTo(w1.position.y[EID], 3)
      expect(w2.position.z[EID]).toBeCloseTo(w1.position.z[EID], 3)
    })

    it('full sync: P2 position equals P1 position for an in-flight bullet', async () => {
      const [pA, pB] = peers = [makePeer('p1', network), makePeer('p2', network)]
      await connectAll(peers)

      const w1 = makeWorldArrays()
      const w2 = makeWorldArrays()
      for (const s of makeSchemas(w1)) pA.net.registerComponent(s)
      for (const s of makeSchemas(w2)) pB.net.registerComponent(s)

      const gA = createGroup(pA)
      const gB = createGroup(pB)
      gA.addPeer('p2'); gB.addPeer('p1')

      gB.onDelta(d => applyDeltas(d, w2))

      const EID = 9
      w1.projectile[EID] = 1
      w1.position.x[EID] = 7; w1.position.z[EID] = -3

      pA.net.sendFullSync(GROUP_ID, 'p2', [EID])

      expect(w2.projectile[EID]).toBe(1)
      expect(w2.position.x[EID]).toBeCloseTo(w1.position.x[EID], 3)
      expect(w2.position.z[EID]).toBeCloseTo(w1.position.z[EID], 3)
    })
  })

  // -------------------------------------------------------------------------
  // Bullet movement updates reach P2
  // -------------------------------------------------------------------------

  describe('bullet movement updates', () => {
    it('P2 tracks bullet position across multiple P1 flushes', async () => {
      const [pA, pB] = peers = [makePeer('p1', network), makePeer('p2', network)]
      await connectAll(peers)

      const w1 = makeWorldArrays()
      const w2 = makeWorldArrays()
      for (const s of makeSchemas(w1)) pA.net.registerComponent(s)
      for (const s of makeSchemas(w2)) pB.net.registerComponent(s)

      const gA = createGroup(pA)
      const gB = createGroup(pB)
      gA.addPeer('p2'); gB.addPeer('p1')

      gB.onDelta(d => applyDeltas(d, w2))

      const EID = 7

      // Tick 0: bullet spawns
      w1.projectile[EID] = 1
      w1.position.x[EID] = 0; w1.position.z[EID] = 0
      pA.net.markEntityDirty(EID)
      pA.net.flushGroupDeltas(GROUP_ID, [EID])
      gA.flush()

      expect(w2.position.x[EID]).toBeCloseTo(0, 3)

      // Tick 1: bullet moves
      w1.position.x[EID] = 4.2; w1.position.z[EID] = -12.5
      pA.net.markEntityDirty(EID)
      pA.net.flushGroupDeltas(GROUP_ID, [EID])
      gA.flush()

      expect(w2.position.x[EID]).toBeCloseTo(w1.position.x[EID], 3)
      expect(w2.position.z[EID]).toBeCloseTo(w1.position.z[EID], 3)

      // Tick 2: bullet moves again
      w1.position.x[EID] = 9.0; w1.position.z[EID] = -25.0
      pA.net.markEntityDirty(EID)
      pA.net.flushGroupDeltas(GROUP_ID, [EID])
      gA.flush()

      expect(w2.position.x[EID]).toBeCloseTo(w1.position.x[EID], 3)
      expect(w2.position.z[EID]).toBeCloseTo(w1.position.z[EID], 3)
    })

    it('stationary bullet does not cause a second delta (no redundant sends)', async () => {
      const [pA, pB] = peers = [makePeer('p1', network), makePeer('p2', network)]
      await connectAll(peers)

      const w1 = makeWorldArrays()
      const w2 = makeWorldArrays()
      for (const s of makeSchemas(w1)) pA.net.registerComponent(s)
      for (const s of makeSchemas(w2)) pB.net.registerComponent(s)

      const gA = createGroup(pA)
      const gB = createGroup(pB)
      gA.addPeer('p2'); gB.addPeer('p1')

      let deltaCount = 0
      gB.onDelta(d => { applyDeltas(d, w2); deltaCount++ })

      const EID = 14
      w1.projectile[EID] = 1
      w1.position.x[EID] = 5

      // Two flushes, same values — only first should produce a delta
      pA.net.markEntityDirty(EID)
      pA.net.flushGroupDeltas(GROUP_ID, [EID])
      gA.flush()

      pA.net.markEntityDirty(EID)
      pA.net.flushGroupDeltas(GROUP_ID, [EID])
      gA.flush()

      expect(deltaCount).toBe(1)
      expect(w2.position.x[EID]).toBeCloseTo(5, 3)
    })

    it('projectile flag is not re-sent in movement updates', async () => {
      const [pA, pB] = peers = [makePeer('p1', network), makePeer('p2', network)]
      await connectAll(peers)

      const w1 = makeWorldArrays()
      const w2 = makeWorldArrays()
      for (const s of makeSchemas(w1)) pA.net.registerComponent(s)
      for (const s of makeSchemas(w2)) pB.net.registerComponent(s)

      const gA = createGroup(pA)
      const gB = createGroup(pB)
      gA.addPeer('p2'); gB.addPeer('p1')

      const receivedBatches: DeltaSet[] = []
      gB.onDelta(d => { applyDeltas(d, w2); receivedBatches.push(d) })

      const EID = 3
      // Spawn
      w1.projectile[EID] = 1; w1.position.x[EID] = 1
      pA.net.markEntityDirty(EID)
      pA.net.flushGroupDeltas(GROUP_ID, [EID])
      gA.flush()

      // Move
      w1.position.x[EID] = 2
      pA.net.markEntityDirty(EID)
      pA.net.flushGroupDeltas(GROUP_ID, [EID])
      gA.flush()

      // First batch has the flag; second batch (position update) should not
      const moveBatch = receivedBatches[1]
      expect(moveBatch.some(d => d.componentId === PROJECTILE_COMPONENT_ID)).toBe(false)

      // But P2's position is still correct after the movement update
      expect(w2.position.x[EID]).toBeCloseTo(w1.position.x[EID], 3)
    })
  })
})
