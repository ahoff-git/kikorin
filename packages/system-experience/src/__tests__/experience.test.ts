import { describe, it, expect, beforeEach } from 'vitest'
import { addEntity, addComponent, createWorld } from 'bitecs'
import { createFlaginator } from '@kikorin/system-flaginator'
import { awardXP } from '../experience'
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
      NetFlags: new Int8Array(n),
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

describe('awardXP', () => {
  let world: CoreWorld

  beforeEach(() => {
    world = makeTestWorld()
  })

  function spawnPlayer(experience = 0, level = 1): number {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Player)
    world.components.Player[eid] = { experience, level, name: 'Test' }
    return eid
  }

  it('adds XP to the player', () => {
    const eid = spawnPlayer(0)
    awardXP(world, eid, 5)
    expect(world.components.Player[eid]!.experience).toBe(5)
  })

  it('increments level when experience reaches 100', () => {
    const eid = spawnPlayer(99, 1)
    awardXP(world, eid, 5)
    expect(world.components.Player[eid]!.level).toBe(2)
  })

  it('resets experience to 0 after leveling up', () => {
    const eid = spawnPlayer(99, 1)
    awardXP(world, eid, 5)
    expect(world.components.Player[eid]!.experience).toBe(0)
  })

  it('does nothing when entity has no Player component', () => {
    const eid = addEntity(world)
    expect(() => awardXP(world, eid, 5)).not.toThrow()
  })

  it('accumulates XP across multiple kills', () => {
    const eid = spawnPlayer(0)
    awardXP(world, eid, 5)
    awardXP(world, eid, 5)
    expect(world.components.Player[eid]!.experience).toBe(10)
  })
})
