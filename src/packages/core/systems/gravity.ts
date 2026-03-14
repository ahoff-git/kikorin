import { query } from "bitecs"
import type { CoreWorld } from "../types"

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

const entityHalfExtents: WorldHalfExtents = { x: 0, y: 0, z: 0 }
const floorHalfExtents: WorldHalfExtents = { x: 0, y: 0, z: 0 }

function fillWorldHalfExtents(world: CoreWorld, eid: number, out: WorldHalfExtents) {
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

function findSupportingFloorY(
    world: CoreWorld,
    floorEids: readonly number[],
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
    floorEids: readonly number[],
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
    floorEids: readonly number[],
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

        Gravity.Grounded[eid] = grounded ? 1 : 0
        if (grounded) {
            if (Velocity.y[eid] < 0) {
                Velocity.y[eid] = 0
            }
            continue
        }

        Velocity.y[eid] = Math.max(Velocity.y[eid] - WORLD_GRAVITY * dt, -MAX_FALL_SPEED)
    }
}
