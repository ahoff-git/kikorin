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
import { Euler, Matrix4, Quaternion } from 'three'
import { CoreFlagCustomSources, CoreFlags } from '../coreFlags'
import type { CollisionState, CoreWorld, Position, Vec3 } from '../types'
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
const scratchEuler = new Euler(0, 0, 0, 'YXZ')
const scratchQuaternion = new Quaternion()
const scratchRotationMatrix = new Matrix4()

type ColliderConfig = {
    halfWidth: number,
    halfHeight: number,
    halfDepth: number,
    sensor: boolean,
    active: boolean,
}

type ColliderTransform = {
    translation: RapierVector,
    rotation: RapierRotation,
}

type CastEntityColliderOptions = {
    maxToi?: number,
    stopAtPenetration?: boolean,
    filterFlags?: QueryFilterFlags,
    filterPredicate?: (otherEid: number) => boolean,
}

type CastEntityColliderHit = {
    colliderEid: number,
    toi: number,
    witness1: Vec3,
    witness2: Vec3,
    normal1: Vec3,
    normal2: Vec3,
}

type CollisionBounceResponse = {
    a: RapierVector | null,
    b: RapierVector | null,
}

type CollisionDynamicState = {
    aDynamic: boolean,
    bDynamic: boolean,
    dynamicCount: number,
}

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

function syncTouchingVisualIfChanged(world: CoreWorld, eid: number, changed: boolean) {
    if (changed) {
        syncTouchingVisual(world, eid)
    }
}

function addTouchingEntity(state: CollisionState, eid: number, otherEid: number) {
    const list = getTouchList(state, eid)
    if (list.includes(otherEid)) {
        return false
    }

    list.push(otherEid)
    return true
}

function removeTouchingEntity(state: CollisionState, eid: number, otherEid: number) {
    return removeValueInPlace(getTouchList(state, eid), otherEid)
}

function getSortedPair(a: number, b: number) {
    return a < b ? { min: a, max: b } : { min: b, max: a }
}

function registerTouchPairRecord(world: CoreWorld, a: number, b: number) {
    const state = world.collision
    const key = pairKeyFor(world, a, b)
    if (state.touchPairIndexByKey.has(key)) return

    const pairIndex = state.touchPairs.Count
    const pair = getSortedPair(a, b)
    ensureTouchPairCapacity(state, pairIndex + 1)
    state.touchPairs.A[pairIndex] = pair.min
    state.touchPairs.B[pairIndex] = pair.max
    state.touchPairs.Count += 1
    state.touchPairIndexByKey.set(key, pairIndex)
    state.touchPairKeysByIndex[pairIndex] = key
}

function unregisterTouchPairRecord(world: CoreWorld, a: number, b: number) {
    const state = world.collision
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

function addTouchPair(world: CoreWorld, a: number, b: number) {
    const state = world.collision
    syncTouchingVisualIfChanged(world, a, addTouchingEntity(state, a, b))
    syncTouchingVisualIfChanged(world, b, addTouchingEntity(state, b, a))
    registerTouchPairRecord(world, a, b)
}

function removeTouchPair(world: CoreWorld, a: number, b: number) {
    const state = world.collision
    syncTouchingVisualIfChanged(world, a, removeTouchingEntity(state, a, b))
    syncTouchingVisualIfChanged(world, b, removeTouchingEntity(state, b, a))
    unregisterTouchPairRecord(world, a, b)
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

function fillWorldHalfExtents(world: CoreWorld, eid: number, out: RapierVector) {
    const { Collider, Rotation } = world.components
    const hx = Collider.HalfWidth[eid]
    const hy = Collider.HalfHeight[eid]
    const hz = Collider.HalfDepth[eid]

    scratchEuler.set(
        Rotation.pitch[eid],
        Rotation.yaw[eid],
        Rotation.roll[eid],
    )
    scratchRotationMatrix.makeRotationFromEuler(scratchEuler)

    const { elements } = scratchRotationMatrix
    const m11 = elements[0]!
    const m12 = elements[4]!
    const m13 = elements[8]!
    const m21 = elements[1]!
    const m22 = elements[5]!
    const m23 = elements[9]!
    const m31 = elements[2]!
    const m32 = elements[6]!
    const m33 = elements[10]!

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

function shouldIgnoreCollisionBounce(world: CoreWorld, a: number, b: number) {
    const { Collider, Floor } = world.components
    return Collider.Sensor[a] || Collider.Sensor[b] || Floor[a] || Floor[b]
}

function resolveCollisionNormal(
    world: CoreWorld,
    a: number,
    b: number,
    normal: RapierVector,
) {
    const normalizedNormal = normalize(normal)
    if (normalizedNormal) {
        return normalizedNormal
    }

    const { Position } = world.components
    return normalize({
        x: Position.x[b] - Position.x[a],
        y: Position.y[b] - Position.y[a],
        z: Position.z[b] - Position.z[a],
    })
}

function readCollisionDynamicState(world: CoreWorld, a: number, b: number): CollisionDynamicState {
    const { Velocity } = world.components
    const aDynamic = hasComponent(world, a, Velocity)
    const bDynamic = hasComponent(world, b, Velocity)
    return {
        aDynamic,
        bDynamic,
        dynamicCount: Number(aDynamic) + Number(bDynamic),
    }
}

function readRelativeCollisionVelocity(
    world: CoreWorld,
    a: number,
    b: number,
    dynamicState: CollisionDynamicState,
): RapierVector {
    const { Velocity } = world.components
    return {
        x: (dynamicState.aDynamic ? Velocity.x[a] : 0) - (dynamicState.bDynamic ? Velocity.x[b] : 0),
        y: (dynamicState.aDynamic ? Velocity.y[a] : 0) - (dynamicState.bDynamic ? Velocity.y[b] : 0),
        z: (dynamicState.aDynamic ? Velocity.z[a] : 0) - (dynamicState.bDynamic ? Velocity.z[b] : 0),
    }
}

function createBounceDelta(normal: RapierVector, scalar: number): RapierVector {
    return {
        x: normal.x * scalar,
        y: normal.y * scalar,
        z: normal.z * scalar,
    }
}

function createCollisionBounceResponse(
    normal: RapierVector,
    bounceImpulse: number,
    dynamicState: CollisionDynamicState,
): CollisionBounceResponse | null {
    const response: CollisionBounceResponse = {
        a: dynamicState.aDynamic
            ? createBounceDelta(normal, -bounceImpulse)
            : null,
        b: dynamicState.bDynamic
            ? createBounceDelta(normal, bounceImpulse)
            : null,
    }

    if (!response.a && !response.b) {
        return null
    }

    return response
}

function computeCollisionBounceResponses(
    world: CoreWorld,
    a: number,
    b: number,
    normal: RapierVector,
) {
    if (shouldIgnoreCollisionBounce(world, a, b)) {
        return null
    }

    const normalizedNormal = resolveCollisionNormal(world, a, b, normal)
    if (!normalizedNormal) {
        return null
    }

    const dynamicState = readCollisionDynamicState(world, a, b)
    if (dynamicState.dynamicCount === 0) {
        return null
    }

    const relativeVelocity = readRelativeCollisionVelocity(world, a, b, dynamicState)
    const closingSpeed = dot(relativeVelocity, normalizedNormal)
    if (closingSpeed <= COLLISION_MIN_BOUNCE_SPEED) {
        return null
    }

    const bounceImpulse =
        ((1 + COLLISION_BOUNCE_RESTITUTION) * closingSpeed) /
        dynamicState.dynamicCount
    return createCollisionBounceResponse(
        normalizedNormal,
        bounceImpulse,
        dynamicState,
    )
}

function suggestCollisionBounce(world: CoreWorld, a: number, b: number) {
    const state = world.collision
    const aCollider = state.collidersByEid[a]
    const bCollider = state.collidersByEid[b]
    if (!aCollider?.isValid() || !bCollider?.isValid()) {
        return false
    }

    const contact = aCollider.contactCollider(bCollider, COLLISION_RESPONSE_PREDICTION)
    if (!contact) {
        return false
    }

    const response = computeCollisionBounceResponses(world, a, b, contact.normal1)
    if (!response) {
        return false
    }

    if (response.a) {
        addBounceSuggestion(world, a, response.a)
    }

    if (response.b) {
        addBounceSuggestion(world, b, response.b)
    }

    return true
}

function fillPredictedBounceQueryHalfExtents(
    world: CoreWorld,
    eid: number,
    out: RapierVector,
) {
    fillWorldHalfExtents(world, eid, out)
    out.x += COLLISION_RESPONSE_PREDICTION
    out.y += COLLISION_RESPONSE_PREDICTION
    out.z += COLLISION_RESPONSE_PREDICTION
}

function markBouncePairProcessed(
    world: CoreWorld,
    a: number,
    b: number,
    processedKeys: Set<number>,
) {
    const key = pairKeyFor(world, a, b)
    if (processedKeys.has(key)) {
        return false
    }

    processedKeys.add(key)
    return true
}

function handleBounceCandidate(
    world: CoreWorld,
    eid: number,
    candidateHandle: number,
    processedKeys: Set<number>,
) {
    const otherEid = world.collision.eidByColliderHandle.get(candidateHandle)
    if (otherEid === undefined || otherEid === eid) {
        return
    }

    if (!markBouncePairProcessed(world, eid, otherEid, processedKeys)) {
        return
    }

    suggestCollisionBounce(world, eid, otherEid)
}

function scanBounceCandidatesForEntity(
    world: CoreWorld,
    eid: number,
    processedKeys: Set<number>,
    aabbHalfExtents: RapierVector,
) {
    const state = world.collision
    const collider = state.collidersByEid[eid]
    if (!collider?.isValid() || !state.world) {
        return
    }

    fillPredictedBounceQueryHalfExtents(world, eid, aabbHalfExtents)
    state.world.collidersWithAabbIntersectingAabb(
        collider.translation(),
        aabbHalfExtents,
        (candidate) => {
            handleBounceCandidate(world, eid, candidate.handle, processedKeys)
            return true
        },
    )
}

function computeBounceSuggestions(world: CoreWorld, seedEids: readonly number[]) {
    const state = world.collision
    if (!state.world) return

    const aabbHalfExtents: RapierVector = { x: 0, y: 0, z: 0 }
    const processedKeys = new Set<number>()

    for (let i = 0; i < seedEids.length; i += 1) {
        const eid = seedEids[i]!
        scanBounceCandidatesForEntity(world, eid, processedKeys, aabbHalfExtents)
    }
}

function readColliderConfig(world: CoreWorld, eid: number): ColliderConfig {
    const { Collider } = world.components
    return {
        halfWidth: Collider.HalfWidth[eid],
        halfHeight: Collider.HalfHeight[eid],
        halfDepth: Collider.HalfDepth[eid],
        sensor: Boolean(Collider.Sensor[eid]),
        active: Boolean(Collider.Active[eid]),
    }
}

function readColliderTransform(world: CoreWorld, eid: number): ColliderTransform {
    const { Position, Rotation } = world.components
    return {
        translation: {
            x: Position.x[eid],
            y: Position.y[eid],
            z: Position.z[eid],
        },
        rotation: eulerToQuaternion(
            Rotation.pitch[eid],
            Rotation.yaw[eid],
            Rotation.roll[eid],
        ),
    }
}

function createRapierColliderDesc(
    config: ColliderConfig,
    transform: ColliderTransform,
) {
    return ColliderDesc
        .cuboid(config.halfWidth, config.halfHeight, config.halfDepth)
        .setTranslation(
            transform.translation.x,
            transform.translation.y,
            transform.translation.z,
        )
        .setRotation(transform.rotation)
        .setSensor(config.sensor)
        .setEnabled(config.active)
        .setActiveCollisionTypes(ActiveCollisionTypes.ALL)
}

function syncExistingColliderConfig(
    rapierCollider: RapierCollider,
    config: ColliderConfig,
) {
    rapierCollider.setHalfExtents({
        x: config.halfWidth,
        y: config.halfHeight,
        z: config.halfDepth,
    })
    rapierCollider.setSensor(config.sensor)
    rapierCollider.setEnabled(config.active)
    rapierCollider.setActiveCollisionTypes(ActiveCollisionTypes.ALL)
}

function syncCollider(world: CoreWorld, eid: number, needsConfigSync: boolean) {
    const rapierWorld = world.collision.world
    if (!rapierWorld) return null

    const config = readColliderConfig(world, eid)
    const transform = readColliderTransform(world, eid)
    let rapierCollider = world.collision.collidersByEid[eid]

    if (!rapierCollider || !rapierCollider.isValid()) {
        rapierCollider = rapierWorld.createCollider(
            createRapierColliderDesc(config, transform),
        )
        world.collision.collidersByEid[eid] = rapierCollider
        world.collision.eidByColliderHandle.set(rapierCollider.handle, eid)
        return rapierCollider
    }

    rapierCollider.setTranslation(transform.translation)
    rapierCollider.setRotation(transform.rotation)

    if (needsConfigSync) {
        syncExistingColliderConfig(rapierCollider, config)
    }

    return rapierCollider
}

function collectTouchingEntities(
    state: CollisionState,
    eid: number,
    rapierCollider: RapierCollider,
    nextTouching: number[],
) {
    state.world!.intersectionsWithShape(
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
}

function removeStaleTouchPairs(
    world: CoreWorld,
    eid: number,
    currentTouching: number[],
    nextTouching: readonly number[],
) {
    for (let i = currentTouching.length - 1; i >= 0; i -= 1) {
        const otherEid = currentTouching[i]!
        if (!nextTouching.includes(otherEid)) {
            removeTouchPair(world, eid, otherEid)
        }
    }
}

function addNewTouchPairs(
    world: CoreWorld,
    eid: number,
    currentTouching: readonly number[],
    nextTouching: readonly number[],
) {
    for (let i = 0; i < nextTouching.length; i += 1) {
        const otherEid = nextTouching[i]!
        if (!currentTouching.includes(otherEid)) {
            addTouchPair(world, eid, otherEid)
        }
    }
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

    collectTouchingEntities(state, eid, rapierCollider, nextTouching)

    const currentTouching = getTouchList(state, eid)
    removeStaleTouchPairs(world, eid, currentTouching, nextTouching)
    addNewTouchPairs(world, eid, currentTouching, nextTouching)
}

function clearCollisionDirtyFlag(world: CoreWorld, eid: number) {
    const { CollisionDirtyFlags } = world.components
    CollisionDirtyFlags.DirtyTransformFlag[eid] = 0
    CollisionDirtyFlags.ConfigDirtyFlag[eid] = 0
    CollisionDirtyFlags.DirtyFlagSet[eid] = 0
}

function shouldRemoveCollider(world: CoreWorld, eid: number) {
    const { Collider, Position, Rotation } = world.components
    return (
        !hasComponent(world, eid, Collider) ||
        !hasComponent(world, eid, Position) ||
        !hasComponent(world, eid, Rotation) ||
        !Collider.Active[eid]
    )
}

function syncDirtyCollider(world: CoreWorld, eid: number) {
    const needsConfigSync = world.components.CollisionDirtyFlags.ConfigDirtyFlag[eid] === 1
    const rapierCollider = syncCollider(world, eid, needsConfigSync)
    clearCollisionDirtyFlag(world, eid)
    return rapierCollider ? eid : null
}

function syncDirtyColliders(world: CoreWorld) {
    const { CollisionDirtyFlags } = world.components
    const dirtyCount = CollisionDirtyFlags.DirtyCount
    const syncedEids: number[] = []

    for (let i = 0; i < dirtyCount; i += 1) {
        const eid = CollisionDirtyFlags.DirtyList[i]!

        if (shouldRemoveCollider(world, eid)) {
            removeColliderByEid(world, eid)
            continue
        }

        const syncedEid = syncDirtyCollider(world, eid)
        if (syncedEid !== null) {
            syncedEids.push(syncedEid)
        }
    }

    CollisionDirtyFlags.DirtyCount = 0
    return syncedEids
}

function rebuildTouchingForSyncedEids(world: CoreWorld, syncedEids: readonly number[]) {
    const { Collider } = world.components
    for (let i = 0; i < syncedEids.length; i += 1) {
        const eid = syncedEids[i]!
        if (!Collider.Active[eid]) continue
        rebuildTouchingForEntity(world, eid)
    }
}

function refreshCollisionQueries(world: CoreWorld, syncedEids: readonly number[]) {
    const rapierWorld = world.collision.world
    if (!rapierWorld || syncedEids.length === 0) return

    // Keep Rapier's query structures fresh without advancing any physics simulation.
    rapierWorld.updateSceneQueries()
    computeBounceSuggestions(world, syncedEids)
    rebuildTouchingForSyncedEids(world, syncedEids)
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

    resetBounceSuggestions(world)
    const dirtyCount = world.components.CollisionDirtyFlags.DirtyCount
    if (dirtyCount === 0) return

    const syncedEids = syncDirtyColliders(world)
    refreshCollisionQueries(world, syncedEids)
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

export function getCollisionBounceDelta(
    world: CoreWorld,
    eid: number,
    otherEid: number,
    normal: Vec3,
): Vec3 | null {
    const response = computeCollisionBounceResponses(world, eid, otherEid, normal)
    return response?.a ?? null
}

export function castEntityCollider(
    world: CoreWorld,
    eid: number,
    shapePos: Position,
    shapeVel: Vec3,
    opts: CastEntityColliderOptions = {},
): CastEntityColliderHit | null {
    const state = world.collision
    const rapierWorld = state.world
    const selfCollider = state.collidersByEid[eid]
    if (!rapierWorld || !selfCollider?.isValid()) {
        return null
    }

    if (shapeVel.x === 0 && shapeVel.y === 0 && shapeVel.z === 0) {
        return null
    }

    const hit: ShapeColliderTOI | null = rapierWorld.castShape(
        shapePos,
        readColliderTransform(world, eid).rotation,
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

export function getTouchPairs(world: CoreWorld) {
    return world.collision.touchPairs
}

export function getTouchingEntities(world: CoreWorld, eid: number) {
    return world.collision.touchingByEid[eid] ?? []
}

export { createCollisionState }
