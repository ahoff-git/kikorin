import { query } from "bitecs"
import type { CoreWorld } from "@kikorin/ecs"
import { markFlaginatorComponentChanged } from "@kikorin/system-flaginator"
import { computeFloorSurfaceY, fillWorldHalfExtents } from "./colliderUtils"

const WORLD_GRAVITY = 24
const MAX_FALL_SPEED = 48
const FLOOR_CONTACT_EPSILON = 0.01
const FLOOR_RECOVERY_DISTANCE = 0.35
const FLOOR_SNAP_DISTANCE = 0.08

type Vec3Like = { x: number; y: number; z: number }

const entityHalfExtents: Vec3Like = { x: 0, y: 0, z: 0 }
const floorHalfExtents: Vec3Like = { x: 0, y: 0, z: 0 }

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

        const floorTop = computeFloorSurfaceY(world, floorEid, desiredX, desiredZ)
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

        const floorTop = computeFloorSurfaceY(world, floorEid, desiredX, desiredZ)
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
    const { Floor, Gravity, Position, Velocity } = world.components
    const floorEids = query(world, [Floor, Position, world.components.Rotation, world.components.Collider])

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
