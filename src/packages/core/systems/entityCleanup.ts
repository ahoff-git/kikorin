import { query, removeEntity } from "bitecs"
import type { CoreWorld } from "../types"
import { findHighestFloorTopAtPosition } from "./gravity"
import { removeColliderByEid } from "./collision"
import { removeObjectByEid } from "./render"

const MAX_FALL_DISTANCE_BELOW_FLOOR = 32

function findWorldHighestFloorTop(world: CoreWorld, floorEids: ArrayLike<number>) {
    const { Position } = world.components
    let highestFloorTop = Number.NEGATIVE_INFINITY

    for (let i = 0; i < floorEids.length; i += 1) {
        const floorEid = floorEids[i]!
        const floorTop = findHighestFloorTopAtPosition(
            world,
            floorEids,
            Position.x[floorEid],
            Position.z[floorEid],
        )
        if (floorTop !== null && floorTop > highestFloorTop) {
            highestFloorTop = floorTop
        }
    }

    if (!Number.isFinite(highestFloorTop)) {
        return null
    }

    return highestFloorTop
}

export function destroyEntity(world: CoreWorld, eid: number) {
    removeColliderByEid(world, eid)
    removeObjectByEid(eid)
    removeEntity(world, eid)
}

export function fallCleanupSystem(world: CoreWorld) {
    const { Collider, Floor, Position, Rotation } = world.components
    const floorEids = query(world, [Floor, Position, Rotation, Collider])
    if (floorEids.length === 0) return

    const worldHighestFloorTop = findWorldHighestFloorTop(world, floorEids)
    if (worldHighestFloorTop === null) return

    const doomedEids: number[] = []

    for (const eid of query(world, [Position])) {
        if (Floor[eid]) continue

        const localFloorTop = findHighestFloorTopAtPosition(
            world,
            floorEids,
            Position.x[eid],
            Position.z[eid],
        )
        // Objects that leave the platform entirely should still be culled eventually.
        const referenceFloorTop = localFloorTop ?? worldHighestFloorTop
        if (Position.y[eid] > referenceFloorTop - MAX_FALL_DISTANCE_BELOW_FLOOR) {
            continue
        }

        doomedEids.push(eid)
    }

    for (let i = 0; i < doomedEids.length; i += 1) {
        destroyEntity(world, doomedEids[i]!)
    }
}
