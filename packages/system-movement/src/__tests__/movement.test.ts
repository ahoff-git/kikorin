import { describe, it, expect, beforeEach } from 'vitest'
import { addEntity, addComponent, createWorld } from 'bitecs'
import { createFlaginator } from '@kikorin/system-flaginator'
import { movementSystem } from '../movement'
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

describe('movementSystem', () => {
  let world: CoreWorld

  beforeEach(() => {
    world = makeTestWorld()
  })

  it('moves entity by velocity * dt', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Position)
    addComponent(world, eid, world.components.Velocity)

    world.components.Position.x[eid] = 0
    world.components.Position.y[eid] = 0
    world.components.Position.z[eid] = 0
    world.components.Velocity.x[eid] = 10
    world.components.Velocity.z[eid] = 5
    world.time.delta = 1000 // 1 second

    movementSystem(world)

    // dt = 1000 * 0.001 = 1s; x: 0 + 10*1 = 10; z: 0 + 5*1 = 5
    expect(world.components.Position.x[eid]).toBeCloseTo(10)
    expect(world.components.Position.z[eid]).toBeCloseTo(5)
  })

  it('does not move entities when delta is 0', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Position)
    addComponent(world, eid, world.components.Velocity)

    world.components.Position.x[eid] = 5
    world.components.Velocity.x[eid] = 100
    world.time.delta = 0

    movementSystem(world)

    expect(world.components.Position.x[eid]).toBe(5)
  })

  it('skips entities with the Projectile component', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Position)
    addComponent(world, eid, world.components.Velocity)
    addComponent(world, eid, world.components.Projectile)
    world.components.Projectile[eid] = 1

    world.components.Position.x[eid] = 0
    world.components.Velocity.x[eid] = 100
    world.time.delta = 1000

    movementSystem(world)

    // Projectile entities are skipped
    expect(world.components.Position.x[eid]).toBe(0)
  })

  it('does not move entities that have no velocity', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Position)
    // No Velocity component

    world.components.Position.x[eid] = 3
    world.time.delta = 1000

    movementSystem(world)

    // Not in the [Position, Velocity] query, position unchanged
    expect(world.components.Position.x[eid]).toBe(3)
  })

  it('updates yaw to face velocity direction when FaceVelocity is set', () => {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Position)
    addComponent(world, eid, world.components.Velocity)
    addComponent(world, eid, world.components.Rotation)
    addComponent(world, eid, world.components.FaceVelocity)

    world.components.FaceVelocity[eid] = 1
    world.components.Velocity.x[eid] = 0
    world.components.Velocity.z[eid] = -1 // moving in -Z → yaw should be 0
    world.time.delta = 100

    movementSystem(world)

    // getYawFromXZDirection(0, -1) = atan2(0, 1) = 0
    expect(world.components.Rotation.yaw[eid]).toBeCloseTo(0)
  })
})
