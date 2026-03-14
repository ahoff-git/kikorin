import { query } from "bitecs";
import type { CoreWorld, Position } from "../core";
import { eventBus } from "../mitt";

const TIME_UPDATE_INTERVAL_MS = 100;
const PLAYER_UPDATE_INTERVAL_MS = 100;
const PLAYER_POSITION_UPDATE_INTERVAL_MS = 200;
const CONTROLS_UPDATE_INTERVAL_MS = 100;
const MAX_VISIBLE_CONTROL_STATES = 8;

type UiBridgeSnapshot = {
  timeMetrics: CoreWorld["time"];
  player: CoreWorld["components"]["Player"][number] | null;
  playerPosition: Position | null;
  controlStates: ReturnType<CoreWorld["controls"]["getStates"]>;
};

type UiUpdateDefinition<TValue> = {
  updateKey: string;
  minMS: number;
  readValue: (snapshot: UiBridgeSnapshot) => TValue;
  publish: (value: TValue) => void;
};

function createUiUpdateDefinition<TValue>(
  updateKey: string,
  minMS: number,
  readValue: (snapshot: UiBridgeSnapshot) => TValue,
  publish: (value: TValue) => void,
): UiUpdateDefinition<TValue> {
  return {
    updateKey,
    minMS,
    readValue,
    publish,
  };
}

const uiUpdateDefinitions = {
  timeMetrics: createUiUpdateDefinition(
    "timeMetrics",
    TIME_UPDATE_INTERVAL_MS,
    (snapshot) => snapshot.timeMetrics,
    (timeMetrics) => {
      eventBus.emit("ui:timeMetricsUpdate", { timeMetrics });
    },
  ),
  player: createUiUpdateDefinition(
    "player",
    PLAYER_UPDATE_INTERVAL_MS,
    (snapshot) => snapshot.player,
    (player) => {
      eventBus.emit("ui:playerUpdate", { player });
    },
  ),
  playerPosition: createUiUpdateDefinition(
    "playerPosition",
    PLAYER_POSITION_UPDATE_INTERVAL_MS,
    (snapshot) => snapshot.playerPosition,
    (playerPosition) => {
      eventBus.emit("ui:playerPositionUpdate", { playerPosition });
    },
  ),
  controls: createUiUpdateDefinition(
    "controls",
    CONTROLS_UPDATE_INTERVAL_MS,
    (snapshot) => snapshot.controlStates,
    (controlStates) => {
      eventBus.emit("ui:controlsUpdate", { controlStates });
    },
  ),
} as const;

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

function readPrimaryPlayerSnapshot(world: CoreWorld) {
  const playerEid = findPrimaryPlayerEid(world);
  if (playerEid === null) {
    return {
      player: null,
      playerPosition: null,
    };
  }

  return {
    player: { ...world.components.Player[playerEid]! },
    playerPosition: readPlayerPosition(world, playerEid),
  };
}

function readTimeMetrics(world: CoreWorld) {
  return { ...world.time };
}

function getVisibleControlStates(world: CoreWorld) {
  return world.controls
    .getStates()
    .filter((state) => {
      return state.active || state.triggerCount > 0 || state.activationCount > 0;
    })
    .slice(0, MAX_VISIBLE_CONTROL_STATES);
}

function createUiBridgeSnapshot(world: CoreWorld): UiBridgeSnapshot {
  const playerSnapshot = readPrimaryPlayerSnapshot(world);
  return {
    timeMetrics: readTimeMetrics(world),
    player: playerSnapshot.player,
    playerPosition: playerSnapshot.playerPosition,
    controlStates: getVisibleControlStates(world),
  };
}

function queueUiUpdate<TValue>(
  world: CoreWorld,
  definition: UiUpdateDefinition<TValue>,
  snapshot: UiBridgeSnapshot,
) {
  world.chillUpdater.setUpdate({
    updateKey: definition.updateKey,
    updateFunction: definition.publish,
    value: definition.readValue(snapshot),
    minMS: definition.minMS,
  });
}

export function uiBridgeSystem(world: CoreWorld) {
  const snapshot = createUiBridgeSnapshot(world);

  queueUiUpdate(world, uiUpdateDefinitions.timeMetrics, snapshot);
  queueUiUpdate(world, uiUpdateDefinitions.player, snapshot);
  queueUiUpdate(world, uiUpdateDefinitions.playerPosition, snapshot);
  queueUiUpdate(world, uiUpdateDefinitions.controls, snapshot);

  world.chillUpdater.check();
}
