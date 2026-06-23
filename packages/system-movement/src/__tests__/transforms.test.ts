import { describe, it, expect, beforeEach } from 'vitest'
import { addEntity, addComponent, createWorld } from 'bitecs'
import { createFlaginator } from '@kikorin/system-flaginator'
import {
  getYawFromXZDirection,
  rotateLocalVectorByEntityRotation,
  setEntityPosition,
  setEntityVelocity,
  setEntityRotation,
  markTransformDirty,
} from '../transforms'
import type { CoreWorld } from '@kikorin/ecs'

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

describe('getYawFromXZDirection', () => {
  it('is a function', () => {
    expect(typeof getYawFromXZDirection).toBe('function')
  })

  it('returns 0 for the -z direction (straight ahead)', () => {
    expect(getYawFromXZDirection(0, -1)).toBeCloseTo(0)
  })

  it('returns PI/2 for the -x direction', () => {
    expect(getYawFromXZDirection(-1, 0)).toBeCloseTo(Math.PI / 2)
  })

  it('returns -PI/2 for the +x direction', () => {
    expect(getYawFromXZDirection(1, 0)).toBeCloseTo(-Math.PI / 2)
  })

  it('returns PI for the +z direction', () => {
    expect(Math.abs(getYawFromXZDirection(0, 1))).toBeCloseTo(Math.PI)
  })
})

describe('setEntityPosition', () => {
  let world: CoreWorld

  beforeEach(() => { world = makeTestWorld() })

  it('writes x, y, z and returns true when values change', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Position)

    const changed = setEntityPosition(world, eid, { x: 1, y: 2, z: 3 })

    expect(changed).toBe(true)
    expect(world.components.Position.x[eid]).toBe(1)
    expect(world.components.Position.y[eid]).toBe(2)
    expect(world.components.Position.z[eid]).toBe(3)
  })

  it('returns false when the position is already at the given values', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Position)
    world.components.Position.x[eid] = 5

    expect(setEntityPosition(world, eid, { x: 5 })).toBe(false)
  })

  it('only updates the provided axes', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Position)
    world.components.Position.x[eid] = 1
    world.components.Position.y[eid] = 2
    world.components.Position.z[eid] = 3

    setEntityPosition(world, eid, { y: 10 })

    expect(world.components.Position.x[eid]).toBe(1)
    expect(world.components.Position.y[eid]).toBe(10)
    expect(world.components.Position.z[eid]).toBe(3)
  })
})

describe('setEntityVelocity', () => {
  let world: CoreWorld

  beforeEach(() => { world = makeTestWorld() })

  it('writes velocity components and returns true on change', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Velocity)

    const changed = setEntityVelocity(world, eid, { x: 5, y: 0, z: -3 })

    expect(changed).toBe(true)
    expect(world.components.Velocity.x[eid]).toBe(5)
    expect(world.components.Velocity.z[eid]).toBe(-3)
  })

  it('returns false when velocity is unchanged', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Velocity)

    expect(setEntityVelocity(world, eid, { x: 0, y: 0, z: 0 })).toBe(false)
  })
})

describe('setEntityRotation', () => {
  let world: CoreWorld

  beforeEach(() => { world = makeTestWorld() })

  it('writes rotation components and returns true on change', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Rotation)

    const changed = setEntityRotation(world, eid, { yaw: Math.PI, pitch: 0.5, roll: 0 })

    expect(changed).toBe(true)
    expect(world.components.Rotation.yaw[eid]).toBeCloseTo(Math.PI)
    expect(world.components.Rotation.pitch[eid]).toBeCloseTo(0.5)
  })

  it('returns false when rotation is unchanged from defaults', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Rotation)

    expect(setEntityRotation(world, eid, { yaw: 0, pitch: 0, roll: 0 })).toBe(false)
  })
})

describe('markTransformDirty', () => {
  let world: CoreWorld

  beforeEach(() => { world = makeTestWorld() })

  it('adds entity to DirtyList and increments DirtyCount when Render is set', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Render)
    world.components.Render[eid] = 1

    markTransformDirty(world, eid)

    expect(world.components.RenderDirtyFlags.DirtyCount).toBe(1)
    expect(world.components.RenderDirtyFlags.DirtyTransformFlag[eid]).toBe(1)
    expect(world.components.RenderDirtyFlags.DirtyFlagSet[eid]).toBe(1)
  })

  it('does not duplicate an entity already in the dirty list', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Render)
    world.components.Render[eid] = 1

    markTransformDirty(world, eid)
    markTransformDirty(world, eid)

    expect(world.components.RenderDirtyFlags.DirtyCount).toBe(1)
  })

  it('does not add to DirtyList when entity has no Render component', () => {
    const eid = addEntity(world)
    // Render[eid] = 0 by default

    markTransformDirty(world, eid)

    expect(world.components.RenderDirtyFlags.DirtyCount).toBe(0)
  })
})

describe('rotateLocalVectorByEntityRotation', () => {
  let world: CoreWorld

  beforeEach(() => { world = makeTestWorld() })

  it('returns the same vector when rotation is zero', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Rotation)
    // yaw=0, pitch=0, roll=0 by default

    const result = rotateLocalVectorByEntityRotation(world, eid, { x: 1, y: 0, z: 0 })

    expect(result.x).toBeCloseTo(1)
    expect(result.y).toBeCloseTo(0)
    expect(result.z).toBeCloseTo(0)
  })

  it('rotates forward vector when yaw is PI/2', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Rotation)
    // Euler YXZ: set(pitch=0, yaw=PI/2, roll=0) → PI/2 rotation around Y
    // (1,0,0) rotated PI/2 around Y → (0,0,-1)
    world.components.Rotation.yaw[eid] = Math.PI / 2

    const result = rotateLocalVectorByEntityRotation(world, eid, { x: 1, y: 0, z: 0 })

    expect(result.x).toBeCloseTo(0)
    expect(result.y).toBeCloseTo(0)
    expect(result.z).toBeCloseTo(-1)
  })
})
