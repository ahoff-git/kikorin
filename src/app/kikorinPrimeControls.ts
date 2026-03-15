import { type CoreWorld } from "@/packages/core/core";
import { registerPrimeMovementControls } from "./kikorinPrimeMovement";
import { registerPrimeProjectileControls } from "./kikorinPrimeProjectiles";

export function registerPrimeControls(world: CoreWorld, eid: number) {
  registerPrimeMovementControls(world, eid);
  registerPrimeProjectileControls(world, eid);
}
