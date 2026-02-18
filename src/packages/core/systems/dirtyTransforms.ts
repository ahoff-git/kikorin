import type { CoreWorld } from "../core"
import { setObjectTransformByEid } from "./render"

export function dirtyTransformsSystem(world: CoreWorld) {
    const { Position, Rotation, RenderDirtyFlags } = world.components
    const dirtyCount = RenderDirtyFlags.DirtyCount
    if (dirtyCount === 0) return

    const { DirtyTransformFlag, DirtyFlagSet, DirtyList } = RenderDirtyFlags

    for (let i = 0; i < dirtyCount; i += 1) {
        const eid = DirtyList[i]
        setObjectTransformByEid(
            eid,
            Position.x[eid],
            Position.y[eid],
            Position.z[eid],
            Rotation.pitch[eid],
            Rotation.yaw[eid],
            Rotation.roll[eid]
        )
        DirtyTransformFlag[eid] = 0
        DirtyFlagSet[eid] = 0
    }

    RenderDirtyFlags.DirtyCount = 0
}
