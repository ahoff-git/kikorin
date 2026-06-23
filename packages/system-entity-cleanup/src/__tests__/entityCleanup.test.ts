import { describe, it, expect, vi, beforeEach } from 'vitest'
import { addEntity, addComponent, createWorld, entityExists } from 'bitecs'
import { createFlaginator } from '@kikorin/system-flaginator'
import type { CoreWorld } from '@kikorin/ecs'

vi.mock('@kikorin/system-physics', () => ({
  removeColliderByEid: vi.fn(),
  findHighestFloorTopAtPosition: vi.fn(() => null),
  setupCollisionSystem: vi.fn(),
}))

vi.mock('@kikorin/system-rendering', () => ({
  removeObjectByEid: vi.fn(() => false),
}))

const { destroyEntity } = await import('../entityCleanup')
const { removeColliderByEid } = await import('@kikorin/system-physics')
const { removeObjectByEid } = await import('@kikorin/system-rendering')

const MAX_ENTITIES = 100

function makeTestWorld(): CoreWorld {
  const n = MAX_ENTITIES
  const Player: CoreWorld['components']['Player'] = []

  const config = {
    components: {
      Position: { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n) },
      Velocity: { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n) },
      Rotation: { yaw: new Float32Array(n), pitch: new Float32Array(n), roll: new Float32Array(n) },
      FaceVelocity: new Int8Array(n),
      Projectile: new Int8Array(n),
      Collider: { Active: new Int8Array(n), Sensor: new Int8Array(n), HalfWidth: new Float32Array(n), HalfHeight: new Float32Array(n), HalfDepth: new Float32Array(n) },
      Gravity: { Grounded: new Int8Array(n) },
      Floor: new Int8Array(n),
      RenderDirtyFlags: { DirtyTransformFlag: new Int8Array(n), DirtyCount: 0, DirtyList: new Int32Array(n), DirtyFlagSet: new Int8Array(n) },
      CollisionDirtyFlags: { DirtyTransformFlag: new Int8Array(n), ConfigDirtyFlag: new Int8Array(n), DirtyCount: 0, DirtyList: new Int32Array(n), DirtyFlagSet: new Int8Array(n) },
      Render: new Int32Array(n),
      Health: new Int32Array(n),
      Player,
    },
    collision: {
      ready: false, initStarted: false, initError: null, world: null,
      collidersByEid: [], eidByColliderHandle: new Map(),
      touchingByEid: [],
      touchPairs: { Count: 0, A: new Int32Array(n), B: new Int32Array(n) },
      touchPairIndexByKey: new Map(), touchPairKeysByIndex: [], scratchTouching: [],
      bounceSuggestions: { Active: new Int8Array(n), x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), DirtyList: new Int32Array(n), DirtyCount: 0, DirtyFlagSet: new Int8Array(n) },
    },
    time: { delta: 0, elapsed: 0, then: 0, deltaBuffer: { push: () => {}, average: () => 0, clear: () => {}, size: () => 0 }, avgDelta: 0, ticksPerSecond: 0 },
    commands: { queue: [], handlers: new Map(), enqueue: () => 0, on: () => () => {}, process: () => {}, clear: () => {} },
    controls: { queue: [], states: new Map(), enqueue: () => 0, on: () => () => {}, onTick: () => () => {}, process: () => {}, getState: () => undefined, getStates: () => [], getActiveStates: () => [], isActive: () => false, isAnyActive: () => false, getAxis: () => 0, cancelActive: () => {}, clear: () => {} },
    chillUpdater: { setUpdate: () => {}, check: () => false },
    flaginator: createFlaginator<CoreWorld>(n),
  }

  return createWorld(config) as unknown as CoreWorld
}

describe('destroyEntity', () => {
  let world: CoreWorld

  beforeEach(() => {
    world = makeTestWorld()
    vi.clearAllMocks()
  })

  it('removes the entity from the bitecs world', () => {
    const eid = addEntity(world)
    expect(entityExists(world, eid)).toBe(true)

    destroyEntity(world, eid)

    expect(entityExists(world, eid)).toBe(false)
  })

  it('calls removeColliderByEid with the world and eid', () => {
    const eid = addEntity(world)
    destroyEntity(world, eid)
    expect(removeColliderByEid).toHaveBeenCalledWith(world, eid)
  })

  it('calls removeObjectByEid with the eid', () => {
    const eid = addEntity(world)
    destroyEntity(world, eid)
    expect(removeObjectByEid).toHaveBeenCalledWith(eid)
  })

  it('can destroy multiple different entities', () => {
    const eid1 = addEntity(world)
    const eid2 = addEntity(world)

    destroyEntity(world, eid1)
    destroyEntity(world, eid2)

    expect(entityExists(world, eid1)).toBe(false)
    expect(entityExists(world, eid2)).toBe(false)
  })
})
