import { query } from "bitecs"
import { CoreWorld } from "../core"

export function experienceSystem(world: CoreWorld) {
        const { Player } = world.components

        for (const eid of query(world, [Player])) {
            Player[eid].experience += world.time.delta / 1000
            if (Player[eid].experience >= 100) {
                Player[eid].level++
                Player[eid].experience = 0
            }
        }
    }