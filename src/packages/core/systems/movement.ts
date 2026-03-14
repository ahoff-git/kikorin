import { query } from "bitecs"
import type { CoreWorld } from "../types"
import { markTransformDirty } from "./transforms"

export function movementSystem(world: CoreWorld) {
    const { Position, Velocity } = world.components
    const delta = world.time.delta
    if (delta === 0) return

    const dt = delta * 0.001
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
        if (vx === 0 && vy === 0 && vz === 0) continue

        posX[eid] += vx * dt
        posY[eid] += vy * dt
        posZ[eid] += vz * dt

        markTransformDirty(world, eid)
    }
}
