import { query } from "bitecs"
import type { CoreWorld } from "../types"
import { destroyEntity } from "./entityCleanup"

export function healthSystem (world: CoreWorld) {
    const { Health } = world.components
    const doomedEids: number[] = []

    for (const eid of query(world, [Health])) {
        if (Health[eid] <= 0) {
            doomedEids.push(eid)
        }
    }

    for (let i = 0; i < doomedEids.length; i += 1) {
        destroyEntity(world, doomedEids[i]!)
    }
}
