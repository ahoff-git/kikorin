import RAPIER, {
    ActiveCollisionTypes,
    type Collider as RapierCollider,
    ColliderDesc,
    type Rotation as RapierRotation,
    type Vector as RapierVector,
} from '@dimforge/rapier3d-compat'
import { hasComponent } from 'bitecs'
import type { CollisionState, CoreWorld } from '../types'
import { setObjectTouchingByEid } from './render'

const INITIAL_TOUCH_PAIR_CAPACITY = 1024
const IDENTITY_ROTATION: RapierRotation = { x: 0, y: 0, z: 0, w: 1 }

let rapierInitPromise: Promise<void> | null = null

function ensureRapierInit() {
    if (!rapierInitPromise) {
        rapierInitPromise = RAPIER.init()
    }
    return rapierInitPromise
}

function createCollisionState(maxEntities: number): CollisionState {
    return {
        ready: false,
        initStarted: false,
        initError: null,
        world: null,
        collidersByEid: new Array<RapierCollider | null>(maxEntities).fill(null),
        eidByColliderHandle: new Map<number, number>(),
        touchingByEid: new Array<number[]>(maxEntities),
        touchPairs: {
            Count: 0,
            A: new Int32Array(INITIAL_TOUCH_PAIR_CAPACITY),
            B: new Int32Array(INITIAL_TOUCH_PAIR_CAPACITY),
        },
        touchPairIndexByKey: new Map<number, number>(),
        touchPairKeysByIndex: [],
        scratchTouching: [],
    }
}

function ensureTouchPairCapacity(state: CollisionState, minCapacity: number) {
    const currentCapacity = state.touchPairs.A.length
    if (currentCapacity >= minCapacity) return

    let nextCapacity = currentCapacity || INITIAL_TOUCH_PAIR_CAPACITY
    while (nextCapacity < minCapacity) {
        nextCapacity <<= 1
    }

    const nextA = new Int32Array(nextCapacity)
    const nextB = new Int32Array(nextCapacity)
    nextA.set(state.touchPairs.A.subarray(0, state.touchPairs.Count))
    nextB.set(state.touchPairs.B.subarray(0, state.touchPairs.Count))
    state.touchPairs.A = nextA
    state.touchPairs.B = nextB
}

function pairKeyFor(world: CoreWorld, a: number, b: number) {
    const min = a < b ? a : b
    const max = a < b ? b : a
    const entityStride = world.components.Render.length
    return min * entityStride + max
}

function getTouchList(state: CollisionState, eid: number) {
    let list = state.touchingByEid[eid]
    if (!list) {
        list = []
        state.touchingByEid[eid] = list
    }
    return list
}

function removeValueInPlace(list: number[], value: number) {
    const index = list.indexOf(value)
    if (index < 0) return false

    const lastIndex = list.length - 1
    if (index !== lastIndex) {
        list[index] = list[lastIndex]!
    }
    list.length = lastIndex
    return true
}

function shouldShowTouchingState(world: CoreWorld, eid: number) {
    if (world.components.Floor[eid]) return false

    const list = getTouchList(world.collision, eid)
    for (let i = 0; i < list.length; i += 1) {
        if (!world.components.Floor[list[i]!]) {
            return true
        }
    }

    return false
}

function syncTouchingVisual(world: CoreWorld, eid: number) {
    setObjectTouchingByEid(eid, shouldShowTouchingState(world, eid))
}

function addTouchPair(world: CoreWorld, a: number, b: number) {
    const state = world.collision
    const aList = getTouchList(state, a)
    if (!aList.includes(b)) {
        aList.push(b)
        syncTouchingVisual(world, a)
    }

    const bList = getTouchList(state, b)
    if (!bList.includes(a)) {
        bList.push(a)
        syncTouchingVisual(world, b)
    }

    const key = pairKeyFor(world, a, b)
    if (state.touchPairIndexByKey.has(key)) return

    const pairIndex = state.touchPairs.Count
    ensureTouchPairCapacity(state, pairIndex + 1)
    const min = a < b ? a : b
    const max = a < b ? b : a
    state.touchPairs.A[pairIndex] = min
    state.touchPairs.B[pairIndex] = max
    state.touchPairs.Count += 1
    state.touchPairIndexByKey.set(key, pairIndex)
    state.touchPairKeysByIndex[pairIndex] = key
}

function removeTouchPair(world: CoreWorld, a: number, b: number) {
    const state = world.collision

    const aList = getTouchList(state, a)
    const aRemoved = removeValueInPlace(aList, b)
    if (aRemoved) {
        syncTouchingVisual(world, a)
    }

    const bList = getTouchList(state, b)
    const bRemoved = removeValueInPlace(bList, a)
    if (bRemoved) {
        syncTouchingVisual(world, b)
    }

    const key = pairKeyFor(world, a, b)
    const pairIndex = state.touchPairIndexByKey.get(key)
    if (pairIndex === undefined) return

    const lastIndex = state.touchPairs.Count - 1
    if (pairIndex !== lastIndex) {
        state.touchPairs.A[pairIndex] = state.touchPairs.A[lastIndex]!
        state.touchPairs.B[pairIndex] = state.touchPairs.B[lastIndex]!

        const movedKey = state.touchPairKeysByIndex[lastIndex]!
        state.touchPairKeysByIndex[pairIndex] = movedKey
        state.touchPairIndexByKey.set(movedKey, pairIndex)
    }

    state.touchPairs.Count = lastIndex
    state.touchPairKeysByIndex.length = lastIndex
    state.touchPairIndexByKey.delete(key)
}

function clearTouchingForEntity(world: CoreWorld, eid: number) {
    const state = world.collision
    const list = state.touchingByEid[eid]
    if (!list?.length) return

    while (list.length > 0) {
        const other = list[list.length - 1]!
        removeTouchPair(world, eid, other)
    }
}

function eulerToQuaternion(pitch: number, yaw: number, roll: number): RapierRotation {
    if (pitch === 0 && yaw === 0 && roll === 0) {
        return IDENTITY_ROTATION
    }

    const halfPitch = pitch * 0.5
    const halfYaw = yaw * 0.5
    const halfRoll = roll * 0.5
    const sinPitch = Math.sin(halfPitch)
    const cosPitch = Math.cos(halfPitch)
    const sinYaw = Math.sin(halfYaw)
    const cosYaw = Math.cos(halfYaw)
    const sinRoll = Math.sin(halfRoll)
    const cosRoll = Math.cos(halfRoll)

    return {
        x: sinPitch * cosYaw * cosRoll - cosPitch * sinYaw * sinRoll,
        y: cosPitch * sinYaw * cosRoll + sinPitch * cosYaw * sinRoll,
        z: cosPitch * cosYaw * sinRoll - sinPitch * sinYaw * cosRoll,
        w: cosPitch * cosYaw * cosRoll + sinPitch * sinYaw * sinRoll,
    }
}

function syncCollider(world: CoreWorld, eid: number, needsConfigSync: boolean) {
    const rapierWorld = world.collision.world
    if (!rapierWorld) return null

    const { Position, Rotation, Collider } = world.components
    let rapierCollider = world.collision.collidersByEid[eid]

    const hx = Collider.HalfWidth[eid]
    const hy = Collider.HalfHeight[eid]
    const hz = Collider.HalfDepth[eid]
    const translation: RapierVector = {
        x: Position.x[eid],
        y: Position.y[eid],
        z: Position.z[eid],
    }
    const rotation = eulerToQuaternion(
        Rotation.pitch[eid],
        Rotation.yaw[eid],
        Rotation.roll[eid],
    )

    if (!rapierCollider || !rapierCollider.isValid()) {
        const desc = ColliderDesc
            .cuboid(hx, hy, hz)
            .setTranslation(translation.x, translation.y, translation.z)
            .setRotation(rotation)
            .setSensor(Boolean(Collider.Sensor[eid]))
            .setEnabled(Boolean(Collider.Active[eid]))
            .setActiveCollisionTypes(ActiveCollisionTypes.ALL)

        rapierCollider = rapierWorld.createCollider(desc)
        world.collision.collidersByEid[eid] = rapierCollider
        world.collision.eidByColliderHandle.set(rapierCollider.handle, eid)
        return rapierCollider
    }

    rapierCollider.setTranslation(translation)
    rapierCollider.setRotation(rotation)

    if (needsConfigSync) {
        rapierCollider.setHalfExtents({ x: hx, y: hy, z: hz })
        rapierCollider.setSensor(Boolean(Collider.Sensor[eid]))
        rapierCollider.setEnabled(Boolean(Collider.Active[eid]))
        rapierCollider.setActiveCollisionTypes(ActiveCollisionTypes.ALL)
    }

    return rapierCollider
}

function rebuildTouchingForEntity(world: CoreWorld, eid: number) {
    const state = world.collision
    const rapierCollider = state.collidersByEid[eid]
    if (!rapierCollider || !rapierCollider.isValid() || !state.world) {
        clearTouchingForEntity(world, eid)
        return
    }

    const nextTouching = state.scratchTouching
    nextTouching.length = 0

    state.world.intersectionsWithShape(
        rapierCollider.translation(),
        rapierCollider.rotation(),
        rapierCollider.shape,
        (candidate) => {
            const otherEid = state.eidByColliderHandle.get(candidate.handle)
            if (otherEid === undefined || otherEid === eid) {
                return true
            }

            nextTouching.push(otherEid)
            return true
        },
        undefined,
        undefined,
        rapierCollider,
    )

    const currentTouching = getTouchList(state, eid)
    for (let i = currentTouching.length - 1; i >= 0; i -= 1) {
        const otherEid = currentTouching[i]!
        if (!nextTouching.includes(otherEid)) {
            removeTouchPair(world, eid, otherEid)
        }
    }

    for (let i = 0; i < nextTouching.length; i += 1) {
        const otherEid = nextTouching[i]!
        if (!currentTouching.includes(otherEid)) {
            addTouchPair(world, eid, otherEid)
        }
    }
}

function clearCollisionDirtyFlag(world: CoreWorld, eid: number) {
    const { CollisionDirtyFlags } = world.components
    CollisionDirtyFlags.DirtyTransformFlag[eid] = 0
    CollisionDirtyFlags.ConfigDirtyFlag[eid] = 0
    CollisionDirtyFlags.DirtyFlagSet[eid] = 0
}

export function markCollisionTransformDirty(world: CoreWorld, eid: number) {
    const { CollisionDirtyFlags, Collider } = world.components
    if (
        CollisionDirtyFlags.DirtyFlagSet[eid] ||
        (!Collider.Active[eid] && !world.collision.collidersByEid[eid])
    ) {
        return
    }

    const dirtyIndex = CollisionDirtyFlags.DirtyCount
    CollisionDirtyFlags.DirtyTransformFlag[eid] = 1
    CollisionDirtyFlags.DirtyFlagSet[eid] = 1
    CollisionDirtyFlags.DirtyList[dirtyIndex] = eid
    CollisionDirtyFlags.DirtyCount = dirtyIndex + 1
}

export function markCollisionConfigDirty(world: CoreWorld, eid: number) {
    world.components.CollisionDirtyFlags.ConfigDirtyFlag[eid] = 1
    markCollisionTransformDirty(world, eid)
}

export function configureCuboidCollider(
    world: CoreWorld,
    eid: number,
    opts: {
        halfWidth: number,
        halfHeight: number,
        halfDepth: number,
        sensor?: boolean,
        active?: boolean,
    },
) {
    const { Collider } = world.components
    Collider.HalfWidth[eid] = opts.halfWidth
    Collider.HalfHeight[eid] = opts.halfHeight
    Collider.HalfDepth[eid] = opts.halfDepth
    Collider.Sensor[eid] = opts.sensor ? 1 : 0
    Collider.Active[eid] = opts.active === false ? 0 : 1
    markCollisionConfigDirty(world, eid)
}

export function setupCollisionSystem(world: CoreWorld) {
    if (world.collision.initStarted) return

    world.collision.initStarted = true
    void ensureRapierInit()
        .then(() => {
            world.collision.world = new RAPIER.World({ x: 0, y: 0, z: 0 })
            world.collision.ready = true
            world.collision.initError = null
        })
        .catch((error: unknown) => {
            world.collision.initError = error instanceof Error ? error.message : String(error)
        })
}

export function removeColliderByEid(world: CoreWorld, eid: number) {
    const state = world.collision
    const rapierCollider = state.collidersByEid[eid]
    if (rapierCollider && rapierCollider.isValid() && state.world) {
        state.world.removeCollider(rapierCollider, false)
    }

    if (rapierCollider) {
        state.eidByColliderHandle.delete(rapierCollider.handle)
    }

    state.collidersByEid[eid] = null
    clearTouchingForEntity(world, eid)
    clearCollisionDirtyFlag(world, eid)
}

export function collisionSystem(world: CoreWorld) {
    if (!world.collision.ready || !world.collision.world) return

    const { CollisionDirtyFlags, Collider, Position, Rotation } = world.components
    const dirtyCount = CollisionDirtyFlags.DirtyCount
    if (dirtyCount === 0) return

    let updatedColliderCount = 0
    for (let i = 0; i < dirtyCount; i += 1) {
        const eid = CollisionDirtyFlags.DirtyList[i]!

        if (
            !hasComponent(world, eid, Collider) ||
            !hasComponent(world, eid, Position) ||
            !hasComponent(world, eid, Rotation) ||
            !Collider.Active[eid]
        ) {
            removeColliderByEid(world, eid)
            continue
        }

        const rapierCollider = syncCollider(
            world,
            eid,
            CollisionDirtyFlags.ConfigDirtyFlag[eid] === 1,
        )
        clearCollisionDirtyFlag(world, eid)
        if (rapierCollider) {
            updatedColliderCount += 1
        }
    }

    CollisionDirtyFlags.DirtyCount = 0

    if (updatedColliderCount === 0) return

    // Keep Rapier's query structures fresh without advancing any physics simulation.
    world.collision.world.updateSceneQueries()

    for (let i = 0; i < dirtyCount; i += 1) {
        const eid = CollisionDirtyFlags.DirtyList[i]!
        if (!Collider.Active[eid]) continue
        rebuildTouchingForEntity(world, eid)
    }
}

export function getTouchPairs(world: CoreWorld) {
    return world.collision.touchPairs
}

export function getTouchingEntities(world: CoreWorld, eid: number) {
    return world.collision.touchingByEid[eid] ?? []
}

export { createCollisionState }
