import { hasComponent, query } from "bitecs"
import type { CoreWorld } from "../types"
import { markFlaginatorComponentChanged } from "./flaginator"
import { resolveFloorPosition } from "./gravity"
import {
    getYawFromXZDirection,
    markTransformDirty,
    setEntityRotation,
} from "./transforms"

const FACE_VELOCITY_MIN_SPEED_SQUARED = 0.0001

export function movementSystem(world: CoreWorld) {
    const { Collider, FaceVelocity, Floor, Gravity, Position, Projectile, Rotation, Velocity } = world.components
    const delta = world.time.delta
    if (delta === 0) return

    const dt = delta * 0.001
    const floorEids = query(world, [Floor, Position, Rotation, Collider])
    const posX = Position.x
    const posY = Position.y
    const posZ = Position.z
    const velX = Velocity.x
    const velY = Velocity.y
    const velZ = Velocity.z

    for (const eid of query(world, [Position, Velocity])) {
        if (hasComponent(world, eid, Projectile)) {
            continue
        }

        const vx = velX[eid]
        const vy = velY[eid]
        const vz = velZ[eid]
        const nextX = posX[eid] + vx * dt
        let nextY = posY[eid] + vy * dt
        const nextZ = posZ[eid] + vz * dt
        let velocityChanged = false

        if (
            hasComponent(world, eid, Gravity) &&
            hasComponent(world, eid, Rotation) &&
            hasComponent(world, eid, Collider)
        ) {
            const resolvedY = resolveFloorPosition(world, floorEids, eid, nextX, nextY, nextZ)
            const grounded = resolvedY !== null
            const groundedValue = grounded ? 1 : 0
            if (Gravity.Grounded[eid] !== groundedValue) {
                Gravity.Grounded[eid] = groundedValue
                markFlaginatorComponentChanged(world, "Gravity", eid)
            }

            if (grounded) {
                nextY = resolvedY
                if (velY[eid] < 0) {
                    velY[eid] = 0
                    velocityChanged = true
                }
            }
        }

        if (
            hasComponent(world, eid, FaceVelocity) &&
            hasComponent(world, eid, Rotation) &&
            vx * vx + vz * vz > FACE_VELOCITY_MIN_SPEED_SQUARED
        ) {
            setEntityRotation(world, eid, {
                yaw: getYawFromXZDirection(vx, vz),
            })
        }

        if (
            nextX === posX[eid] &&
            nextY === posY[eid] &&
            nextZ === posZ[eid]
        ) {
            if (velocityChanged) {
                markFlaginatorComponentChanged(world, "Velocity", eid)
            }
            continue
        }

        posX[eid] = nextX
        posY[eid] = nextY
        posZ[eid] = nextZ
        markFlaginatorComponentChanged(world, "Position", eid)

        markTransformDirty(world, eid)

        if (velocityChanged) {
            markFlaginatorComponentChanged(world, "Velocity", eid)
        }
    }
}
