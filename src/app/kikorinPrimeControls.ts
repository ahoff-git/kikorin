import {
  type ControlEvent,
  type CoreCommand,
  type CoreWorld,
} from "@/packages/core/core";
import {
  handlePrimeMovementControlEvent,
  updatePrimeMovementControls,
} from "./kikorinPrimeMovement";
import {
  createPrimeProjectileRegistry,
  handlePrimeProjectileControlEvent,
  updatePrimeProjectiles,
} from "./kikorinPrimeProjectiles";
import { PlayerCommandTypes } from "./kikorinControls";

type PrimeControlCommandPayload = {
  eid: number;
  event: ControlEvent;
};

function createPrimeControlCommandPayload(
  eid: number,
  event: ControlEvent,
): PrimeControlCommandPayload {
  return {
    eid,
    event,
  };
}

function readPrimeControlCommandPayload(
  command: CoreCommand,
): PrimeControlCommandPayload | null {
  const { payload } = command;
  if (payload === null || typeof payload !== "object") {
    return null;
  }

  const candidate = payload as Partial<PrimeControlCommandPayload>;
  if (typeof candidate.eid !== "number") {
    return null;
  }

  if (candidate.event === undefined || candidate.event === null) {
    return null;
  }

  return candidate as PrimeControlCommandPayload;
}

export function registerPrimeControls(world: CoreWorld, eid: number) {
  const projectiles = createPrimeProjectileRegistry();

  world.commands.on(PlayerCommandTypes.ControlEvent, (activeWorld, command) => {
    const payload = readPrimeControlCommandPayload(command);
    if (!payload || payload.eid !== eid) {
      return;
    }

    handlePrimeMovementControlEvent(activeWorld, eid, payload.event);
    handlePrimeProjectileControlEvent(
      activeWorld,
      eid,
      projectiles,
      payload.event,
    );
  });

  world.controls.onTick((activeWorld, tick, controls) => {
    const frameEvents = controls.getFrameEvents();
    for (let i = 0; i < frameEvents.length; i += 1) {
      const event = frameEvents[i]!;
      activeWorld.commands.enqueue({
        timestamp: event.timestamp,
        source: event.source,
        type: PlayerCommandTypes.ControlEvent,
        payload: createPrimeControlCommandPayload(eid, event),
      });
    }

    updatePrimeMovementControls(activeWorld, eid, tick.deltaSeconds, controls);
    updatePrimeProjectiles(activeWorld, projectiles, tick.deltaSeconds);
  });
}
