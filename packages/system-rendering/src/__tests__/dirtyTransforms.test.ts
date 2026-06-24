import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CoreWorld } from '@kikorin/ecs'

vi.mock('../render', () => ({
  setObjectTransformByEid: vi.fn(() => false),
}))

const { dirtyTransformsSystem } = await import('../dirtyTransforms')
const { setObjectTransformByEid } = await import('../render')

const MAX_ENTITIES = 100

function makeRenderWorld(): CoreWorld {
  const n = MAX_ENTITIES
  return {
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
      Player: [],
    },
  } as unknown as CoreWorld
}

describe('dirtyTransformsSystem', () => {
  let world: CoreWorld

  beforeEach(() => {
    world = makeRenderWorld()
    vi.clearAllMocks()
  })

  it('does nothing when DirtyCount is 0', () => {
    dirtyTransformsSystem(world)
    expect(setObjectTransformByEid).not.toHaveBeenCalled()
  })

  it('calls setObjectTransformByEid for each dirty entity', () => {
    const eid = 5
    world.components.Position.x[eid] = 1
    world.components.Position.y[eid] = 2
    world.components.Position.z[eid] = 3
    world.components.Rotation.pitch[eid] = 4
    world.components.Rotation.yaw[eid] = 5
    world.components.Rotation.roll[eid] = 6
    world.components.RenderDirtyFlags.DirtyList[0] = eid
    world.components.RenderDirtyFlags.DirtyCount = 1

    dirtyTransformsSystem(world)

    expect(setObjectTransformByEid).toHaveBeenCalledWith(eid, 1, 2, 3, 4, 5, 6)
  })

  it('resets DirtyCount to 0 after processing', () => {
    world.components.RenderDirtyFlags.DirtyList[0] = 3
    world.components.RenderDirtyFlags.DirtyCount = 1

    dirtyTransformsSystem(world)

    expect(world.components.RenderDirtyFlags.DirtyCount).toBe(0)
  })

  it('clears DirtyTransformFlag and DirtyFlagSet for each processed entity', () => {
    const eid = 7
    world.components.RenderDirtyFlags.DirtyTransformFlag[eid] = 1
    world.components.RenderDirtyFlags.DirtyFlagSet[eid] = 1
    world.components.RenderDirtyFlags.DirtyList[0] = eid
    world.components.RenderDirtyFlags.DirtyCount = 1

    dirtyTransformsSystem(world)

    expect(world.components.RenderDirtyFlags.DirtyTransformFlag[eid]).toBe(0)
    expect(world.components.RenderDirtyFlags.DirtyFlagSet[eid]).toBe(0)
  })

  it('processes multiple dirty entities in order', () => {
    const eids = [2, 4, 6]
    eids.forEach((eid, i) => {
      world.components.RenderDirtyFlags.DirtyList[i] = eid
    })
    world.components.RenderDirtyFlags.DirtyCount = 3

    dirtyTransformsSystem(world)

    expect(setObjectTransformByEid).toHaveBeenCalledTimes(3)
    eids.forEach((eid) => {
      expect(setObjectTransformByEid).toHaveBeenCalledWith(eid, expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number), expect.any(Number))
    })
  })
})
