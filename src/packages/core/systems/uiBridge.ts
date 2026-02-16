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
        chillUpdater.check();
    }

    function sendTimeUpdate(value: CoreWorld["time"]) {
        eventBus.emit("ui:timeMetricsUpdate", { time: value });
    }

    function sendPlayerUpdate(value: CoreWorld["components"]["Player"][number]) {
        eventBus.emit("ui:playerUpdate", { Player: value });
    }