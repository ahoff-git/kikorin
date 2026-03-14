import { CoreWorld } from "../core";
import { eventBus } from "../mitt";

export function uiBridgeSystem (world: CoreWorld) {
        const { time, components, chillUpdater } = world;
        chillUpdater.setUpdate({
            updateKey: "ticksPerSecond",
            updateFunction: sendTimeUpdate,
            value: time,
            minMS: 100
        });
        chillUpdater.setUpdate({
            updateKey: "playerUpdate",
            updateFunction: sendPlayerUpdate,
            value: { ...components.Player[1] },
            minMS: 100
        });
        chillUpdater.setUpdate({
            updateKey: "playerUpdateLoc",
            updateFunction: sendPlayerLocUpdate,
            value: { x: components.Position.x[1], y: components.Position.y[1], z: components.Position.z[1] },
            minMS: 200
        });
        chillUpdater.setUpdate({
            updateKey: "controlsUpdate",
            updateFunction: sendControlsUpdate,
            value: world.controls.getStates().filter((state) => {
                return state.active || state.triggerCount > 0 || state.activationCount > 0;
            }).slice(0, 8),
            minMS: 100
        });
        chillUpdater.check();
    }

    function sendTimeUpdate(value: CoreWorld["time"]) {
        eventBus.emit("ui:timeMetricsUpdate", { time: value });
    }

    function sendPlayerUpdate(value: CoreWorld["components"]["Player"][number]) {
        eventBus.emit("ui:playerUpdate", { Player: value });
    }

    function sendPlayerLocUpdate(value: CoreWorld["components"]["Position"]) {
        eventBus.emit("ui:playerUpdateLoc", { Player: value });
    }

    function sendControlsUpdate(
        value: ReturnType<CoreWorld["controls"]["getStates"]>
    ) {
        eventBus.emit("ui:controlsUpdate", { controls: value });
    }
