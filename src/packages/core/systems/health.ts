import { query, removeEntity } from "bitecs"
import { CoreWorld } from "../core"

export function healthSystem (world: CoreWorld) {
        const { Health } = world.components
        for (const eid of query(world, [Health])) {
            if (Health[eid] <= 0) {
                removeEntity(world, eid)
                //todo make sure we ask three and rapier to clean up their entities too
            }
        }
    }