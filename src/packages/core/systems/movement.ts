import { hasComponent, query } from "bitecs"
import type { CoreWorld } from "../types"
import { resolveFloorPosition } from "./gravity"
import { markTransformDirty } from "./transforms"

export function movementSystem(world: CoreWorld) {
    const { Collider, Floor, Gravity, Position, Rotation, Velocity } = world.components
    const delta = world.time.delta
    if (delta === 0) return

    const dt = delta * 0.001
    const floorEids = query(world, [Floor, Position, Rotation, Collider])
    const posX = Position.x
    const posY = Position.y
    const posZ = Position.z
    const velX = Velocity.x
    const velY = Velocity.y
    const velZ = Velocity.z

    for (const eid of query(world, [Position, Velocity])) {
        const vx = velX[eid]
        const vy = velY[eid]
        const vz = velZ[eid]
        const nextX = posX[eid] + vx * dt
        let nextY = posY[eid] + vy * dt
        const nextZ = posZ[eid] + vz * dt

        if (
            hasComponent(world, eid, Gravity) &&
            hasComponent(world, eid, Rotation) &&
            hasComponent(world, eid, Collider)
        ) {
            const resolvedY = resolveFloorPosition(world, floorEids, eid, nextX, nextY, nextZ)
            const grounded = resolvedY !== null
            Gravity.Grounded[eid] = grounded ? 1 : 0

            if (grounded) {
                nextY = resolvedY
                if (velY[eid] < 0) {
                    velY[eid] = 0
                }
            }
        }

        if (
            nextX === posX[eid] &&
            nextY === posY[eid] &&
            nextZ === posZ[eid]
        ) {
            continue
        }

        posX[eid] = nextX
        posY[eid] = nextY
        posZ[eid] = nextZ

        markTransformDirty(world, eid)
    }
}
