import { query } from "bitecs"
import type { CoreWorld } from "../types"
import { destroyEntity } from "./entityCleanup"

export function healthSystem (world: CoreWorld) {
    const { Health } = world.components
    const healthEids = query(world, [world.components.Health])
    const doomedEids: number[] = []
    if (healthEids.length === 0) return

    for (let i = 0; i < healthEids.length; i += 1) {
        const eid = healthEids[i]!
        if (Health[eid] <= 0) {
            doomedEids.push(eid)
        }
    }

    for (let i = 0; i < doomedEids.length; i += 1) {
        destroyEntity(world, doomedEids[i]!)
    }
}
