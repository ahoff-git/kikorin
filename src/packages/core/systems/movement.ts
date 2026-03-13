import { query } from "bitecs"
import type { CoreWorld } from "../types"
import { markCollisionTransformDirty } from "./collision"

export function movementSystem(world: CoreWorld) {
    const { Position, Velocity, Render, RenderDirtyFlags, Collider } = world.components
    const delta = world.time.delta
    if (delta === 0) return

    const dt = delta * 0.001
    const posX = Position.x
    const posY = Position.y
    const posZ = Position.z
    const velX = Velocity.x
    const velY = Velocity.y
    const velZ = Velocity.z
    const render = Render
    const { DirtyTransformFlag, DirtyList, DirtyFlagSet } = RenderDirtyFlags
    let dirtyCount = RenderDirtyFlags.DirtyCount

    for (const eid of query(world, [Position, Velocity])) {
        const vx = velX[eid]
        const vy = velY[eid]
        const vz = velZ[eid]
        if (vx === 0 && vy === 0 && vz === 0) continue

        posX[eid] += vx * dt
        posY[eid] += vy * dt
        posZ[eid] += vz * dt

        if (render[eid] && !DirtyFlagSet[eid]) {
            DirtyTransformFlag[eid] = 1
            DirtyFlagSet[eid] = 1
            DirtyList[dirtyCount] = eid
            dirtyCount += 1
        }

        if (Collider.Active[eid]) {
            markCollisionTransformDirty(world, eid)
        }
    }

    RenderDirtyFlags.DirtyCount = dirtyCount
}
