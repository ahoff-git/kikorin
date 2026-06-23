import { query } from "bitecs"
import { Euler, Matrix4 } from "three"
import type { CoreWorld } from "../types"
import { markFlaginatorComponentChanged } from "./flaginator"

const WORLD_GRAVITY = 24
const MAX_FALL_SPEED = 48
const FLOOR_CONTACT_EPSILON = 0.01
const FLOOR_RECOVERY_DISTANCE = 0.35
const FLOOR_SNAP_DISTANCE = 0.08

type WorldHalfExtents = {
    x: number,
    y: number,
    z: number
}

type HalfExtentsCache = {
    tickKey: number,
    tickStamp: number,
    stamps: Uint32Array,
    x: Float32Array,
    y: Float32Array,
    z: Float32Array
}

type FloorQueryCache = {
    tickKey: number,
    eids: number[]
}

const entityHalfExtents: WorldHalfExtents = { x: 0, y: 0, z: 0 }
const floorHalfExtents: WorldHalfExtents = { x: 0, y: 0, z: 0 }
const scratchEuler = new Euler(0, 0, 0, "YXZ")
const scratchRotationMatrix = new Matrix4()
const halfExtentsCacheByWorld = new WeakMap<CoreWorld, HalfExtentsCache>()
const floorQueryCacheByWorld = new WeakMap<CoreWorld, FloorQueryCache>()

function computeWorldHalfExtents(world: CoreWorld, eid: number, out: WorldHalfExtents) {
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

function getHalfExtentsCache(world: CoreWorld) {
    let cache = halfExtentsCacheByWorld.get(world)
    if (cache) {
        return cache
    }

    const maxEntities = world.components.Collider.HalfWidth.length
    cache = {
        tickKey: Number.NaN,
        tickStamp: 0,
        stamps: new Uint32Array(maxEntities),
        x: new Float32Array(maxEntities),
        y: new Float32Array(maxEntities),
        z: new Float32Array(maxEntities),
    }
    halfExtentsCacheByWorld.set(world, cache)
    return cache
}

function fillWorldHalfExtents(world: CoreWorld, eid: number, out: WorldHalfExtents) {
    const cache = getHalfExtentsCache(world)
    if (cache.tickKey !== world.time.elapsed) {
        cache.tickKey = world.time.elapsed
        cache.tickStamp += 1
        if (cache.tickStamp === 0) {
            cache.tickStamp = 1
            cache.stamps.fill(0)
        }
    }

    if (cache.stamps[eid] !== cache.tickStamp) {
        computeWorldHalfExtents(world, eid, out)
        cache.stamps[eid] = cache.tickStamp
        cache.x[eid] = out.x
        cache.y[eid] = out.y
        cache.z[eid] = out.z
        return
    }

    out.x = cache.x[eid]!
    out.y = cache.y[eid]!
    out.z = cache.z[eid]!
}

export function getFloorCollisionEids(world: CoreWorld): readonly number[] {
    let cache = floorQueryCacheByWorld.get(world)
    if (!cache) {
        cache = {
            tickKey: Number.NaN,
            eids: [],
        }
        floorQueryCacheByWorld.set(world, cache)
    }

    if (cache.tickKey === world.time.elapsed) {
        return cache.eids
    }

    cache.tickKey = world.time.elapsed
    const queriedFloorEids = query(world, [world.components.Floor, world.components.Position, world.components.Rotation, world.components.Collider])
    cache.eids.length = queriedFloorEids.length
    for (let i = 0; i < queriedFloorEids.length; i += 1) {
        cache.eids[i] = queriedFloorEids[i]!
    }
    return cache.eids
}

export function findHighestFloorTopAtPosition(
    world: CoreWorld,
    floorEids: ArrayLike<number>,
    desiredX: number,
    desiredZ: number,
    maxFloorTop = Number.POSITIVE_INFINITY,
) {
    const { Position } = world.components
    let bestFloorTop = Number.NEGATIVE_INFINITY

    for (let i = 0; i < floorEids.length; i += 1) {
        const floorEid = floorEids[i]!
        fillWorldHalfExtents(world, floorEid, floorHalfExtents)

        if (
            Math.abs(desiredX - Position.x[floorEid]) > floorHalfExtents.x ||
            Math.abs(desiredZ - Position.z[floorEid]) > floorHalfExtents.z
        ) {
            continue
        }

        const floorTop = Position.y[floorEid] + floorHalfExtents.y
        if (floorTop > maxFloorTop) continue

        if (floorTop > bestFloorTop) {
            bestFloorTop = floorTop
        }
    }

    if (!Number.isFinite(bestFloorTop)) {
        return null
    }

    return bestFloorTop
}

function findSupportingFloorY(
    world: CoreWorld,
    floorEids: ArrayLike<number>,
    eid: number,
    currentY: number,
    desiredX: number,
    desiredY: number,
    desiredZ: number,
    snapDistance: number,
) {
    const { Position } = world.components

    fillWorldHalfExtents(world, eid, entityHalfExtents)
    const currentBottom = currentY - entityHalfExtents.y
    const desiredBottom = desiredY - entityHalfExtents.y

    let bestFloorTop = Number.NEGATIVE_INFINITY

    for (let i = 0; i < floorEids.length; i += 1) {
        const floorEid = floorEids[i]!
        if (floorEid === eid) continue

        fillWorldHalfExtents(world, floorEid, floorHalfExtents)

        if (
            Math.abs(desiredX - Position.x[floorEid]) > entityHalfExtents.x + floorHalfExtents.x ||
            Math.abs(desiredZ - Position.z[floorEid]) > entityHalfExtents.z + floorHalfExtents.z
        ) {
            continue
        }

        const floorTop = Position.y[floorEid] + floorHalfExtents.y
        if (currentBottom < floorTop - FLOOR_RECOVERY_DISTANCE) continue
        if (desiredBottom > floorTop + snapDistance) continue

        if (floorTop > bestFloorTop) {
            bestFloorTop = floorTop
        }
    }

    if (!Number.isFinite(bestFloorTop)) {
        return null
    }

    return bestFloorTop + entityHalfExtents.y
}

function hasFloorSupportAt(
    world: CoreWorld,
    floorEids: ArrayLike<number>,
    eid: number,
    x: number,
    y: number,
    z: number,
) {
    return findSupportingFloorY(
        world,
        floorEids,
        eid,
        y,
        x,
        y,
        z,
        FLOOR_CONTACT_EPSILON,
    ) !== null
}

export function resolveFloorPosition(
    world: CoreWorld,
    floorEids: ArrayLike<number>,
    eid: number,
    desiredX: number,
    desiredY: number,
    desiredZ: number,
) {
    return findSupportingFloorY(
        world,
        floorEids,
        eid,
        world.components.Position.y[eid],
        desiredX,
        desiredY,
        desiredZ,
        FLOOR_SNAP_DISTANCE,
    )
}

export function gravitySystem(world: CoreWorld) {
    const delta = world.time.delta
    if (delta === 0) return

    const dt = delta * 0.001
    const { Gravity, Position, Velocity } = world.components
    const floorEids = getFloorCollisionEids(world)

    for (const eid of query(world, [Position, Velocity, Gravity])) {
        const nextX = Position.x[eid] + Velocity.x[eid] * dt
        const nextZ = Position.z[eid] + Velocity.z[eid] * dt
        const grounded = hasFloorSupportAt(world, floorEids, eid, nextX, Position.y[eid], nextZ)
        const groundedValue = grounded ? 1 : 0

        if (Gravity.Grounded[eid] !== groundedValue) {
            Gravity.Grounded[eid] = groundedValue
            markFlaginatorComponentChanged(world, "Gravity", eid)
        }
        if (grounded) {
            if (Velocity.y[eid] < 0) {
                Velocity.y[eid] = 0
                markFlaginatorComponentChanged(world, "Velocity", eid)
            }
            continue
        }

        const nextVelocityY = Math.max(Velocity.y[eid] - WORLD_GRAVITY * dt, -MAX_FALL_SPEED)
        if (Velocity.y[eid] !== nextVelocityY) {
            Velocity.y[eid] = nextVelocityY
            markFlaginatorComponentChanged(world, "Velocity", eid)
        }
    }
}
