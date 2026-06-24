import { hasComponent, query } from "bitecs"
import type { CoreWorld } from "@kikorin/ecs"
import { isProjectileType, shouldSimulateLocally } from "@kikorin/ecs"
import { markFlaginatorComponentChanged } from "@kikorin/system-flaginator"
import { castEntityCollider, computeFloorSurfaceY, resolveFloorPosition } from "@kikorin/system-physics"
import {
    getYawFromXZDirection,
    markTransformDirty,
    setEntityRotation,
} from "./transforms"

const FACE_VELOCITY_MIN_SPEED_SQUARED = 0.0001
// Pull back from wall face to avoid starting the next frame inside the wall
const WALL_SEPARATION_TOI = 0.001
// Floor contacts within this distance above the player's foot level are surface-transition
// lips — skip wall collision and let the floor-snap system handle the step-up instead.
// Any floor whose surface is more than this above the foot is a genuine blocking wall.
const FLOOR_LIP_THRESHOLD = 0.1

export function movementSystem(world: CoreWorld) {
    const { Collider, FaceVelocity, Floor, Gravity, Player, Position, Rotation, Velocity } = world.components
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
        if (!shouldSimulateLocally(world, eid)) {
            continue
        }

        const vx = velX[eid]
        const vy = velY[eid]
        const vz = velZ[eid]
        const dx = vx * dt
        const dz = vz * dt
        let nextX = posX[eid] + dx
        let nextY = posY[eid] + vy * dt
        let nextZ = posZ[eid] + dz
        let velocityChanged = false

        // Wall collision for player entities: swept shape cast + wall slide
        if (
            hasComponent(world, eid, Player) &&
            hasComponent(world, eid, Collider) &&
            (dx !== 0 || dz !== 0)
        ) {
            const currentPos = { x: posX[eid], y: posY[eid], z: posZ[eid] }
            const hit = castEntityCollider(world, eid, currentPos, { x: dx, y: 0, z: dz }, {
                filterPredicate: (targetEid) => {
                    if (Collider.Sensor[targetEid]) return false
                    if (hasComponent(world, targetEid, Player)) return false
                    if (isProjectileType(world, targetEid)) return false
                    if (Floor[targetEid]) {
                        // Skip floor entities whose surface is at or above the player's
                        // foot — a horizontal hit there is a transition lip between two
                        // co-planar surfaces, not a genuine wall. The floor-snap system
                        // handles the step-up. Floors whose surface is well above the
                        // foot (player approaching from below) still block as walls.
                        const playerBottom = posY[eid] - Collider.HalfHeight[eid]!
                        const surfaceY = computeFloorSurfaceY(world, targetEid, posX[eid], posZ[eid])
                        return playerBottom < surfaceY - FLOOR_LIP_THRESHOLD
                    }
                    return true
                },
            })

            if (hit) {
                const safeToi = Math.max(0, hit.toi - WALL_SEPARATION_TOI)
                nextX = posX[eid] + dx * safeToi
                nextZ = posZ[eid] + dz * safeToi

                // Slide: project remaining movement onto wall plane (strip the component into the wall)
                const remainingT = 1 - hit.toi
                if (remainingT > 0.001) {
                    const nx = hit.normal1.x
                    const nz = hit.normal1.z
                    const dot = dx * nx + dz * nz
                    nextX += (dx - dot * nx) * remainingT
                    nextZ += (dz - dot * nz) * remainingT
                }
            }
        }

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
