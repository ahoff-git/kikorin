import mitt from "mitt";
import type { ControlState, CoreWorld, Position } from "./core";

export type EventBusEvents = {
  "ui:playerUpdate": { player: CoreWorld["components"]["Player"][number] | null };
  "ui:playerPositionUpdate": { playerPosition: Position | null };
  "ui:healthChange": { health: CoreWorld["components"]["Health"][number] };
  "ui:timeMetricsUpdate": { timeMetrics: CoreWorld["time"] };
  "ui:controlsUpdate": { controlStates: ControlState[] };
};

export const eventBus = mitt<EventBusEvents>();
