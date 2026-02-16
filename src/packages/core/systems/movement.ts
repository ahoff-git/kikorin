import { query } from "bitecs"
import { CoreWorld } from "../core"

export function movementSystem(world: CoreWorld) {
        const { Position, Velocity } = world.components

        for (const eid of query(world, [Position, Velocity])) {
            Position.x[eid] += Velocity.x[eid] * world.time.delta
            Position.y[eid] += Velocity.y[eid] * world.time.delta
        }
    }