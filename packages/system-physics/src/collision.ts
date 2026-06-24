import RAPIER, {
    ActiveCollisionTypes,
    type Collider as RapierCollider,
    ColliderDesc,
    type QueryFilterFlags,
    type Rotation as RapierRotation,
    type ShapeColliderTOI,
    type Vector as RapierVector,
} from '@dimforge/rapier3d-compat'
import { hasComponent } from 'bitecs'
import { Euler, Quaternion } from 'three'
import { CoreFlagCustomSources, CoreFlags } from '@kikorin/ecs'
import type { CollisionState, CoreWorld, Position, Vec3 } from '@kikorin/ecs'
import {
    evaluateFlaginatorFlag,
    markFlaginatorComponentChanged,
    markFlaginatorCustomSourceChanged,
} from '@kikorin/system-flaginator'
import { setObjectTouchingByEid } from '@kikorin/system-rendering'
import { fillWorldHalfExtents } from './colliderUtils'
import {
    pairKeyFor,
    resetBounceSuggestions,
    computeBounceSuggestions,
} from './collisionBounce'

const INITIAL_TOUCH_PAIR_CAPACITY = 1024
const COLLISION_RESPONSE_PREDICTION = 0.001
const IDENTITY_ROTATION: RapierRotation = { x: 0, y: 0, z: 0, w: 1 }
const scratchEuler = new Euler(0, 0, 0, 'YXZ')
const scratchQuaternion = new Quaternion()

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
        bounceSuggestions: {
            Active: new Int8Array(maxEntities),
            x: new Float32Array(maxEntities),
            y: new Float32Array(maxEntities),
            z: new Float32Array(maxEntities),
            DirtyList: new Int32Array(maxEntities),
            DirtyCount: 0,
            DirtyFlagSet: new Int8Array(maxEntities),
        },
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

function syncTouchingVisual(world: CoreWorld, eid: number) {
    markFlaginatorCustomSourceChanged(world, CoreFlagCustomSources.Touching, eid)
    setObjectTouchingByEid(
        eid,
        evaluateFlaginatorFlag(world, CoreFlags.TouchingNonFloor, eid),
    )
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

    scratchEuler.set(pitch, yaw, roll)
    scratchQuaternion.setFromEuler(scratchEuler)

    return {
        x: scratchQuaternion.x,
        y: scratchQuaternion.y,
        z: scratchQuaternion.z,
        w: scratchQuaternion.w,
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
    markFlaginatorComponentChanged(world, "Collider", eid)
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
    resetBounceSuggestions(world)
    const dirtyCount = CollisionDirtyFlags.DirtyCount
    if (dirtyCount === 0) return

    const syncedEids: number[] = []
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
            syncedEids.push(eid)
        }
    }

    CollisionDirtyFlags.DirtyCount = 0

    if (updatedColliderCount === 0) return

    // Keep Rapier's query structures fresh without advancing any physics simulation.
    world.collision.world.updateSceneQueries()
    computeBounceSuggestions(world, syncedEids)

    for (let i = 0; i < syncedEids.length; i += 1) {
        const eid = syncedEids[i]!
        if (!Collider.Active[eid]) continue
        rebuildTouchingForEntity(world, eid)
    }
}

export function castEntityCollider(
    world: CoreWorld,
    eid: number,
    shapePos: Position,
    shapeVel: Vec3,
    opts: {
        maxToi?: number,
        stopAtPenetration?: boolean,
        filterFlags?: QueryFilterFlags,
        filterPredicate?: (otherEid: number) => boolean,
    } = {},
): {
    colliderEid: number,
    toi: number,
    witness1: Vec3,
    witness2: Vec3,
    normal1: Vec3,
    normal2: Vec3,
} | null {
    const state = world.collision
    const rapierWorld = state.world
    const selfCollider = state.collidersByEid[eid]
    if (!rapierWorld || !selfCollider?.isValid()) {
        return null
    }

    if (shapeVel.x === 0 && shapeVel.y === 0 && shapeVel.z === 0) {
        return null
    }

    const { Rotation } = world.components
    const hit: ShapeColliderTOI | null = rapierWorld.castShape(
        shapePos,
        eulerToQuaternion(
            Rotation.pitch[eid],
            Rotation.yaw[eid],
            Rotation.roll[eid],
        ),
        shapeVel,
        selfCollider.shape,
        opts.maxToi ?? 1,
        opts.stopAtPenetration ?? false,
        opts.filterFlags,
        undefined,
        selfCollider,
        undefined,
        (collider) => {
            const otherEid = state.eidByColliderHandle.get(collider.handle)
            if (otherEid === undefined || otherEid === eid) {
                return false
            }

            return opts.filterPredicate?.(otherEid) ?? true
        },
    )
    if (!hit) {
        return null
    }

    const otherEid = state.eidByColliderHandle.get(hit.collider.handle)
    if (otherEid === undefined) {
        return null
    }

    return {
        colliderEid: otherEid,
        toi: hit.toi,
        witness1: hit.witness1,
        witness2: hit.witness2,
        normal1: hit.normal1,
        normal2: hit.normal2,
    }
}

export function castRayFromTo(
    world: CoreWorld,
    from: { x: number; y: number; z: number },
    to: { x: number; y: number; z: number },
    opts: {
        filterFlags?: QueryFilterFlags;
        filterPredicate?: (eid: number) => boolean;
    } = {},
): { toi: number; colliderEid: number } | null {
    const { collision } = world
    const rapierWorld = collision.world
    if (!rapierWorld) return null

    const dx = to.x - from.x
    const dy = to.y - from.y
    const dz = to.z - from.z
    const distance = Math.hypot(dx, dy, dz)
    if (distance === 0) return null

    const ray = new RAPIER.Ray(from, { x: dx / distance, y: dy / distance, z: dz / distance })
    const hit = rapierWorld.castRay(
        ray,
        distance,
        true,
        opts.filterFlags,
        undefined,
        undefined,
        undefined,
        opts.filterPredicate
            ? (collider) => {
                  const eid = collision.eidByColliderHandle.get(collider.handle)
                  return eid !== undefined && opts.filterPredicate!(eid)
              }
            : undefined,
    )
    if (!hit) return null

    const colliderEid = collision.eidByColliderHandle.get(hit.collider.handle)
    if (colliderEid === undefined) return null

    return { toi: hit.toi / distance, colliderEid }
}

export function getTouchPairs(world: CoreWorld) {
    return world.collision.touchPairs
}

export function getTouchingEntities(world: CoreWorld, eid: number) {
    return world.collision.touchingByEid[eid] ?? []
}

export { createCollisionState }
