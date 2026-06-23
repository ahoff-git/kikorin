import { Euler, Matrix4 } from 'three'
import type { CoreWorld } from '@kikorin/ecs'

const scratchEuler = new Euler(0, 0, 0, 'YXZ')
const scratchRotationMatrix = new Matrix4()

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
