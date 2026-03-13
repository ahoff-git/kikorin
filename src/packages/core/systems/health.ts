import { query, removeEntity } from "bitecs"
import type { CoreWorld } from "../types"
import { removeColliderByEid } from "./collision"
import { removeObjectByEid } from "./render"

export function healthSystem (world: CoreWorld) {
        const { Health } = world.components
        for (const eid of query(world, [Health])) {
            if (Health[eid] <= 0) {
                removeColliderByEid(world, eid)
                removeObjectByEid(eid)
                removeEntity(world, eid)
            }
        }
    }
