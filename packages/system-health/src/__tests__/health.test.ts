import { describe, it, expect, vi, beforeEach } from 'vitest'
import { addEntity, addComponent, createWorld, hasComponent } from 'bitecs'
import {
  createFlaginator,
  registerFlaginatorFlag,
  flagComponentDependency,
  flagMarkerDependency,
} from '@kikorin/system-flaginator'
import { CoreFlags } from '@kikorin/ecs'
import type { CoreWorld } from '@kikorin/ecs'

vi.mock('@kikorin/system-entity-cleanup', () => ({
  destroyEntity: vi.fn(),
}))

// Import after mock so we get the mocked version
const { destroyEntity } = await import('@kikorin/system-entity-cleanup')
const { healthSystem } = await import('../health')

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

  const world = createWorld(config) as unknown as CoreWorld

  // Register the Dead flag so evaluateAllFlaginatorFlags works correctly
  registerFlaginatorFlag(world, CoreFlags.Dead, {
    dependencies: [
      flagComponentDependency('Health'),
      flagMarkerDependency('HealthChanged'),
    ],
    evaluate: ({ world: w, eid }) => {
      const { Health } = w.components
      return hasComponent(w, eid, Health) && Health[eid] <= 0
    },
  })

  return world
}

describe('healthSystem', () => {
  let world: CoreWorld

  beforeEach(() => {
    world = makeTestWorld()
    vi.clearAllMocks()
  })

  function spawnWithHealth(hp: number): number {
    const eid = addEntity(world)
    addComponent(world, eid, world.components.Health)
    world.components.Health[eid] = hp
    return eid
  }

  it('does nothing when there are no health entities', () => {
    healthSystem(world)
    expect(destroyEntity).not.toHaveBeenCalled()
  })

  it('does not destroy entities with positive health', () => {
    spawnWithHealth(100)
    healthSystem(world)
    expect(destroyEntity).not.toHaveBeenCalled()
  })

  it('destroys entities with health <= 0', () => {
    const eid = spawnWithHealth(0)
    healthSystem(world)
    expect(destroyEntity).toHaveBeenCalledWith(world, eid)
  })

  it('destroys entities with negative health', () => {
    const eid = spawnWithHealth(-10)
    healthSystem(world)
    expect(destroyEntity).toHaveBeenCalledWith(world, eid)
  })

  it('only destroys dead entities, not living ones', () => {
    const aliveEid = spawnWithHealth(50)
    const deadEid = spawnWithHealth(0)

    healthSystem(world)

    expect(destroyEntity).toHaveBeenCalledTimes(1)
    expect(destroyEntity).toHaveBeenCalledWith(world, deadEid)
    expect(destroyEntity).not.toHaveBeenCalledWith(world, aliveEid)
  })

  it('destroys all dead entities in one tick', () => {
    const dead1 = spawnWithHealth(0)
    const dead2 = spawnWithHealth(-5)
    spawnWithHealth(100) // alive — should not be destroyed

    healthSystem(world)

    expect(destroyEntity).toHaveBeenCalledTimes(2)
    expect(destroyEntity).toHaveBeenCalledWith(world, dead1)
    expect(destroyEntity).toHaveBeenCalledWith(world, dead2)
  })
})
