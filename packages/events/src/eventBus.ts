import mitt from "mitt";

export type Time = { avgDelta: number; ticksPerSecond: number };

/**
 * Only events with a live emitter belong here — a subscription to an event
 * nobody emits is UI that silently never updates. Emitters today:
 * `ui:timeMetricsUpdate` (useEngine patch handler), `ui:crosshairAimPoint`
 * (game aim raycast), `ui:playerHealth` (3D game's health-bar bridge over the
 * player's SemanticPatch — ADR 0021).
 */
export type EventBusEvents = {
  "ui:timeMetricsUpdate": { timeMetrics: Time };
  "ui:crosshairAimPoint": { wx: number; wy: number; wz: number };
  "ui:playerHealth": { health: number; max: number };
};

export const eventBus = mitt<EventBusEvents>();
