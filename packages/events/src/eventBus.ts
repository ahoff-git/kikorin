import mitt from "mitt";

// These types were previously imported from @kikorin/ecs (now removed).
export type Player = { name: string; experience: number; level: number };
export type Position = { x: number; y: number; z: number };
export type Time = { avgDelta: number; ticksPerSecond: number };
export type ControlState = { controlId: string; phase: string; source: string };

export type EventBusEvents = {
  "ui:playerUpdate": { player: Player | null };
  "ui:playerPositionUpdate": { playerPosition: Position | null };
  "ui:healthChange": { health: number };
  "ui:timeMetricsUpdate": { timeMetrics: Time };
  "ui:controlsUpdate": { controlStates: ControlState[] };
  "ui:sprintStaminaUpdate": { stamina: number };
  "ui:crosshairAimPoint": { wx: number; wy: number; wz: number };
};

export const eventBus = mitt<EventBusEvents>();
