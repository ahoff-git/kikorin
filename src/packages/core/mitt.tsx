import mitt from "mitt";
import type { ControlState, CoreWorld, Position } from "./core";

type Events = {
  "ui:playerUpdate": { Player:CoreWorld["components"]["Player"][number] };
  "ui:playerUpdateLoc": { Player: Position };
  "ui:healthChange": { Health:CoreWorld["components"]["Health"][number] };
  "ui:timeMetricsUpdate": { time:CoreWorld["time"]};
  "ui:controlsUpdate": { controls: ControlState[] };
};

export const eventBus = mitt<Events>();
