import { query } from "bitecs";
import type { CoreWorld, Position } from "../core";
import { eventBus } from "../mitt";

const TIME_UPDATE_INTERVAL_MS = 100;
const PLAYER_UPDATE_INTERVAL_MS = 100;
const PLAYER_POSITION_UPDATE_INTERVAL_MS = 200;
const CONTROLS_UPDATE_INTERVAL_MS = 100;
const MAX_VISIBLE_CONTROL_STATES = 8;

function findPrimaryPlayerEid(world: CoreWorld) {
    const { Player } = world.components;
    const playerEids = query(world, [Player]);
    return playerEids[0] ?? null;
}

function readPlayerPosition(world: CoreWorld, eid: number): Position {
    const { Position } = world.components;
    return {
        x: Position.x[eid],
        y: Position.y[eid],
        z: Position.z[eid],
    };
}

function readTimeMetrics(world: CoreWorld) {
    return { ...world.time };
}

function getVisibleControlStates(world: CoreWorld) {
    return world.controls
        .getStates()
        .filter((state) => state.active || state.triggerCount > 0 || state.activationCount > 0)
        .slice(0, MAX_VISIBLE_CONTROL_STATES);
}

export function uiBridgeSystem(world: CoreWorld) {
    const { chillUpdater } = world;
    const playerEid = findPrimaryPlayerEid(world);
    const player =
        playerEid === null ? null : { ...world.components.Player[playerEid]! };
    const playerPosition =
        playerEid === null ? null : readPlayerPosition(world, playerEid);
    const timeMetrics = readTimeMetrics(world);

    chillUpdater.setUpdate({
        updateKey: "timeMetrics",
        updateFunction: sendTimeMetricsUpdate,
        value: timeMetrics,
        minMS: TIME_UPDATE_INTERVAL_MS,
    });
    chillUpdater.setUpdate({
        updateKey: "player",
        updateFunction: sendPlayerUpdate,
        value: player,
        minMS: PLAYER_UPDATE_INTERVAL_MS,
    });
    chillUpdater.setUpdate({
        updateKey: "playerPosition",
        updateFunction: sendPlayerPositionUpdate,
        value: playerPosition,
        minMS: PLAYER_POSITION_UPDATE_INTERVAL_MS,
    });
    chillUpdater.setUpdate({
        updateKey: "controls",
        updateFunction: sendControlsUpdate,
        value: getVisibleControlStates(world),
        minMS: CONTROLS_UPDATE_INTERVAL_MS,
    });
    chillUpdater.check();
}

function sendTimeMetricsUpdate(value: CoreWorld["time"]) {
    eventBus.emit("ui:timeMetricsUpdate", { timeMetrics: value });
}

function sendPlayerUpdate(value: CoreWorld["components"]["Player"][number] | null) {
    eventBus.emit("ui:playerUpdate", { player: value });
}

function sendPlayerPositionUpdate(value: Position | null) {
    eventBus.emit("ui:playerPositionUpdate", { playerPosition: value });
}

function sendControlsUpdate(
    value: ReturnType<CoreWorld["controls"]["getStates"]>
) {
    eventBus.emit("ui:controlsUpdate", { controlStates: value });
}
