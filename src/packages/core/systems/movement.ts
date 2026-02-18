import { query } from "bitecs"
import { CoreWorld } from "../core"

export function movementSystem(world: CoreWorld, markTransformDirty: (eid: number) => void) {
        const { Position, Velocity, Render } = world.components
        const delta = world.time.delta
        if (delta === 0) return

        for (const eid of query(world, [Position, Velocity])) {
            const vx = Velocity.x[eid]
            const vy = Velocity.y[eid]
            const vz = Velocity.z[eid]

            if (vx === 0 && vy === 0 && vz === 0) continue

            Position.x[eid] += vx * delta
            Position.y[eid] += vy * delta
            Position.z[eid] += vz * delta
            if (Render[eid]) markTransformDirty(eid)
        }
    }
