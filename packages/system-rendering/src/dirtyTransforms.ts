import { renderChannel } from "@kikorin/adapter"
import { setObjectTransformByEid } from "./render"

export function subscribeToRenderChannel(): () => void {
    return renderChannel.subscribe(() => {
        const patches = renderChannel.getSnapshot()
        for (const patch of patches) {
            setObjectTransformByEid(
                patch.entity,
                patch.x,
                patch.y,
                patch.z,
                patch.pitch,
                patch.yaw,
                patch.roll,
            )
        }
    })
}
