import { Euler, Matrix4 } from 'three'
import type { CoreWorld } from '@kikorin/ecs'

const scratchEuler = new Euler(0, 0, 0, 'YXZ')
const scratchRotationMatrix = new Matrix4()

// For a box floor rotated by yaw (Y-axis) then pitch (X-axis), the top face is a
// plane with normal R*(0,1,0) passing through center+R*(0,hy,0). Solving for the
// world Y at a given (px, pz) yields this closed form:
//   surfaceY = cy + hy/cos(pitch) - tan(pitch)*(sin(yaw)*(px-cx) + cos(yaw)*(pz-cz))
export function computeFloorSurfaceY(world: CoreWorld, floorEid: number, px: number, pz: number): number {
    const { Collider, Position, Rotation } = world.components
    const cy = Position.y[floorEid]!
    const hy = Collider.HalfHeight[floorEid]!
    const pitch = Rotation.pitch[floorEid]!

    if (pitch === 0) {
        return cy + hy
    }

    const cosP = Math.cos(pitch)
    if (Math.abs(cosP) < 0.001) {
        return Number.POSITIVE_INFINITY
    }

    const yaw = Rotation.yaw[floorEid]!
    const cx = Position.x[floorEid]!
    const cz = Position.z[floorEid]!
    const sinP = Math.sin(pitch)
    const projected = Math.sin(yaw) * (px - cx) + Math.cos(yaw) * (pz - cz)
    return cy + hy / cosP - (sinP / cosP) * projected
}

export function fillWorldHalfExtents(
    world: CoreWorld,
    eid: number,
    out: { x: number; y: number; z: number },
) {
    const { Collider, Rotation } = world.components
    const hx = Collider.HalfWidth[eid]
    const hy = Collider.HalfHeight[eid]
    const hz = Collider.HalfDepth[eid]

    scratchEuler.set(
        Rotation.pitch[eid],
        Rotation.yaw[eid],
        Rotation.roll[eid],
    )
    scratchRotationMatrix.makeRotationFromEuler(scratchEuler)

    const { elements } = scratchRotationMatrix
    const m11 = elements[0]!
    const m12 = elements[4]!
    const m13 = elements[8]!
    const m21 = elements[1]!
    const m22 = elements[5]!
    const m23 = elements[9]!
    const m31 = elements[2]!
    const m32 = elements[6]!
    const m33 = elements[10]!

    out.x = Math.abs(m11) * hx + Math.abs(m12) * hy + Math.abs(m13) * hz
    out.y = Math.abs(m21) * hx + Math.abs(m22) * hy + Math.abs(m23) * hz
    out.z = Math.abs(m31) * hx + Math.abs(m32) * hy + Math.abs(m33) * hz
}
