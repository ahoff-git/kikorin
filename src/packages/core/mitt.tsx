import mitt from "mitt";
import type { CoreWorld, Position } from "./core";

export type EventBusEvents = {
  "ui:playerUpdate": { player: CoreWorld["components"]["Player"][number] | null };
  "ui:playerPositionUpdate": { playerPosition: Position | null };
  "ui:healthChange": { health: CoreWorld["components"]["Health"][number] };
  "ui:timeMetricsUpdate": { timeMetrics: CoreWorld["time"] };
};

export const eventBus = mitt<EventBusEvents>();
