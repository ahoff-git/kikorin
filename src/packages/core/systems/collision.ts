import RAPIER, {
    ActiveCollisionTypes,
    type Collider as RapierCollider,
    ColliderDesc,
    type Rotation as RapierRotation,
    type Vector as RapierVector,
} from '@dimforge/rapier3d-compat'
import { hasComponent } from 'bitecs'
import { CoreFlagCustomSources, CoreFlags } from '../coreFlags'
import type { CollisionState, CoreWorld, Vec3 } from '../types'
import {
    evaluateFlaginatorFlag,
    markFlaginatorComponentChanged,
    markFlaginatorCustomSourceChanged,
} from './flaginator'
import { setObjectTouchingByEid } from './render'

const INITIAL_TOUCH_PAIR_CAPACITY = 1024
const IDENTITY_ROTATION: RapierRotation = { x: 0, y: 0, z: 0, w: 1 }
const COLLISION_RESPONSE_PREDICTION = 0.001
const COLLISION_BOUNCE_RESTITUTION = 0.8
const COLLISION_MIN_BOUNCE_SPEED = 0.75

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

function fillWorldHalfExtents(world: CoreWorld, eid: number, out: RapierVector) {
    const { Collider, Rotation } = world.components
    const hx = Collider.HalfWidth[eid]
    const hy = Collider.HalfHeight[eid]
    const hz = Collider.HalfDepth[eid]

    const pitch = Rotation.pitch[eid]
    const yaw = Rotation.yaw[eid]
    const roll = Rotation.roll[eid]

    const a = Math.cos(pitch)
    const b = Math.sin(pitch)
    const c = Math.cos(yaw)
    const d = Math.sin(yaw)
    const e = Math.cos(roll)
    const f = Math.sin(roll)

    const m11 = c * e
    const m12 = -c * f
    const m13 = d
    const m21 = a * f + b * e * d
    const m22 = a * e - b * f * d
    const m23 = -b * c
    const m31 = b * f - a * e * d
    const m32 = b * e + a * f * d
    const m33 = a * c

    out.x = Math.abs(m11) * hx + Math.abs(m12) * hy + Math.abs(m13) * hz
    out.y = Math.abs(m21) * hx + Math.abs(m22) * hy + Math.abs(m23) * hz
    out.z = Math.abs(m31) * hx + Math.abs(m32) * hy + Math.abs(m33) * hz
}

function dot(a: RapierVector, b: RapierVector) {
    return a.x * b.x + a.y * b.y + a.z * b.z
}

function lengthSquared(vector: RapierVector) {
    return dot(vector, vector)
}

function normalize(vector: RapierVector) {
    const lenSq = lengthSquared(vector)
    if (lenSq === 0) return null

    const inverseLength = 1 / Math.sqrt(lenSq)
    return {
        x: vector.x * inverseLength,
        y: vector.y * inverseLength,
        z: vector.z * inverseLength,
    }
}

function resetBounceSuggestions(world: CoreWorld) {
    const suggestions = world.collision.bounceSuggestions
    const dirtyCount = suggestions.DirtyCount
    for (let i = 0; i < dirtyCount; i += 1) {
        const eid = suggestions.DirtyList[i]!
        suggestions.Active[eid] = 0
        suggestions.x[eid] = 0
        suggestions.y[eid] = 0
        suggestions.z[eid] = 0
        suggestions.DirtyFlagSet[eid] = 0
    }

    suggestions.DirtyCount = 0
}

function addBounceSuggestion(world: CoreWorld, eid: number, delta: RapierVector) {
    if (delta.x === 0 && delta.y === 0 && delta.z === 0) {
        return
    }

    const suggestions = world.collision.bounceSuggestions
    if (!suggestions.DirtyFlagSet[eid]) {
        const dirtyIndex = suggestions.DirtyCount
        suggestions.DirtyFlagSet[eid] = 1
        suggestions.DirtyList[dirtyIndex] = eid
        suggestions.DirtyCount = dirtyIndex + 1
    }

    suggestions.Active[eid] = 1
    suggestions.x[eid] += delta.x
    suggestions.y[eid] += delta.y
    suggestions.z[eid] += delta.z
}

function suggestCollisionBounce(world: CoreWorld, a: number, b: number) {
    const state = world.collision
    const aCollider = state.collidersByEid[a]
    const bCollider = state.collidersByEid[b]
    if (!aCollider?.isValid() || !bCollider?.isValid()) {
        return false
    }

    const { Collider, Floor, Position, Velocity } = world.components
    if (Collider.Sensor[a] || Collider.Sensor[b] || Floor[a] || Floor[b]) {
        return false
    }

    const contact = aCollider.contactCollider(bCollider, COLLISION_RESPONSE_PREDICTION)
    if (!contact) {
        return false
    }

    let normal = normalize(contact.normal1)
    if (!normal) {
        normal = normalize({
            x: Position.x[b] - Position.x[a],
            y: Position.y[b] - Position.y[a],
            z: Position.z[b] - Position.z[a],
        })
    }
    if (!normal) {
        return false
    }

    const aDynamic = hasComponent(world, a, Velocity)
    const bDynamic = hasComponent(world, b, Velocity)
    const dynamicCount = Number(aDynamic) + Number(bDynamic)
    if (dynamicCount === 0) {
        return false
    }

    const relativeVelocity = {
        x: (aDynamic ? Velocity.x[a] : 0) - (bDynamic ? Velocity.x[b] : 0),
        y: (aDynamic ? Velocity.y[a] : 0) - (bDynamic ? Velocity.y[b] : 0),
        z: (aDynamic ? Velocity.z[a] : 0) - (bDynamic ? Velocity.z[b] : 0),
    }
    const closingSpeed = dot(relativeVelocity, normal)
    if (closingSpeed <= COLLISION_MIN_BOUNCE_SPEED) {
        return false
    }

    const bounceImpulse = ((1 + COLLISION_BOUNCE_RESTITUTION) * closingSpeed) / dynamicCount

    if (aDynamic) {
        addBounceSuggestion(world, a, {
            x: -normal.x * bounceImpulse,
            y: -normal.y * bounceImpulse,
            z: -normal.z * bounceImpulse,
        })
    }

    if (bDynamic) {
        addBounceSuggestion(world, b, {
            x: normal.x * bounceImpulse,
            y: normal.y * bounceImpulse,
            z: normal.z * bounceImpulse,
        })
    }

    return true
}

function computeBounceSuggestions(world: CoreWorld, seedEids: readonly number[]) {
    const state = world.collision
    if (!state.world) return

    const aabbHalfExtents: RapierVector = { x: 0, y: 0, z: 0 }
    const processedKeys = new Set<number>()

    for (let i = 0; i < seedEids.length; i += 1) {
        const eid = seedEids[i]!
        const collider = state.collidersByEid[eid]
        if (!collider?.isValid()) continue

        fillWorldHalfExtents(world, eid, aabbHalfExtents)

        state.world.collidersWithAabbIntersectingAabb(
            collider.translation(),
            {
                x: aabbHalfExtents.x + COLLISION_RESPONSE_PREDICTION,
                y: aabbHalfExtents.y + COLLISION_RESPONSE_PREDICTION,
                z: aabbHalfExtents.z + COLLISION_RESPONSE_PREDICTION,
            },
            (candidate) => {
                const otherEid = state.eidByColliderHandle.get(candidate.handle)
                if (otherEid === undefined || otherEid === eid) {
                    return true
                }

                const key = pairKeyFor(world, eid, otherEid)
                if (processedKeys.has(key)) {
                    return true
                }

                processedKeys.add(key)
                suggestCollisionBounce(world, eid, otherEid)
                return true
            },
        )
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

export function getBounceSuggestion(world: CoreWorld, eid: number): Vec3 | null {
    const suggestions = world.collision.bounceSuggestions
    if (!suggestions.Active[eid]) {
        return null
    }

    return {
        x: suggestions.x[eid],
        y: suggestions.y[eid],
        z: suggestions.z[eid],
    }
}

export function getTouchPairs(world: CoreWorld) {
    return world.collision.touchPairs
}

export function getTouchingEntities(world: CoreWorld, eid: number) {
    return world.collision.touchingByEid[eid] ?? []
}

export { createCollisionState }
