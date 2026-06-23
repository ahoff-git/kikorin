import { query } from "bitecs"
import { CoreFlags } from "@kikorin/ecs"
import type { CoreWorld } from "@kikorin/ecs"
import { destroyEntity } from "@kikorin/system-entity-cleanup"
import {
    evaluateAllFlaginatorFlags,
    getFlaginatorFlagStore,
} from "@kikorin/system-flaginator"

export function healthSystem (world: CoreWorld) {
    const healthEids = query(world, [world.components.Health])
    const doomedEids: number[] = []
    if (healthEids.length === 0) return

    evaluateAllFlaginatorFlags(world, {
        eids: healthEids,
        flags: [CoreFlags.Dead],
    })
    const deadFlags = getFlaginatorFlagStore(world, CoreFlags.Dead).values

    for (let i = 0; i < healthEids.length; i += 1) {
        const eid = healthEids[i]!
        if (deadFlags[eid] === 1) {
            doomedEids.push(eid)
        }
    }

    for (let i = 0; i < doomedEids.length; i += 1) {
        destroyEntity(world, doomedEids[i]!)
    }
}
