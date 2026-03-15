import {
  setupCoreWorld,
  type CoreWorld,
  type CoreWorldBox,
} from "@/packages/core/core";
import { registerPrimeControls } from "./kikorinPrimeControls";
import {
  createFloor,
  createPrimePlayer,
  FLOOR_POSITION,
  queryFloorEids,
  spawnAmbientPeople,
} from "./kikorinScene";

export type World = CoreWorld;
export type WorldBox = CoreWorldBox;

export function setupWorld(canvas: HTMLCanvasElement | null) {
  const worldBox: WorldBox = setupCoreWorld({
    canvas,
    autoStart: true,
  });
  createFloor(worldBox.world, FLOOR_POSITION);

  const floorEids = queryFloorEids(worldBox.world);
  const prime = createPrimePlayer(worldBox.world, floorEids);
  registerPrimeControls(worldBox.world, prime);
  worldBox.setCameraFollowTarget(prime);
  spawnAmbientPeople(worldBox.world, floorEids);

  return worldBox;
}
