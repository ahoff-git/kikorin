import mitt from "mitt";
import { CoreWorld } from "./core";

type Events = {
  "ui:playerUpdate": { Player:CoreWorld["components"]["Player"][number] };
  "ui:playerUpdateLoc": { Player:CoreWorld["components"]["Position"] };
  "ui:healthChange": { Health:CoreWorld["components"]["Health"][number] };
  "ui:timeMetricsUpdate": { time:CoreWorld["time"]};
};

export const eventBus = mitt<Events>();
