import { Euler, Vector3 } from "three";
import type { CoreWorld, Rotation, Vec3 } from "../types";
import { markCollisionTransformDirty } from "./collision";

const scratchEuler = new Euler();
const scratchVector = new Vector3();

export function markTransformDirty(world: CoreWorld, eid: number) {
  const { RenderDirtyFlags, Render, Collider } = world.components;
  if (Render[eid] && !RenderDirtyFlags.DirtyFlagSet[eid]) {
    const dirtyIndex = RenderDirtyFlags.DirtyCount;
    RenderDirtyFlags.DirtyTransformFlag[eid] = 1;
    RenderDirtyFlags.DirtyFlagSet[eid] = 1;
    RenderDirtyFlags.DirtyList[dirtyIndex] = eid;
    RenderDirtyFlags.DirtyCount = dirtyIndex + 1;
  }

  if (Collider.Active[eid]) {
    markCollisionTransformDirty(world, eid);
  }
}

export function setEntityRotation(
  world: CoreWorld,
  eid: number,
  rotation: Partial<Rotation>,
): boolean {
  const { Rotation } = world.components;
  let didChange = false;

  if (rotation.pitch !== undefined && Rotation.pitch[eid] !== rotation.pitch) {
    Rotation.pitch[eid] = rotation.pitch;
    didChange = true;
  }

  if (rotation.yaw !== undefined && Rotation.yaw[eid] !== rotation.yaw) {
    Rotation.yaw[eid] = rotation.yaw;
    didChange = true;
  }

  if (rotation.roll !== undefined && Rotation.roll[eid] !== rotation.roll) {
    Rotation.roll[eid] = rotation.roll;
    didChange = true;
  }

  if (didChange) {
    markTransformDirty(world, eid);
  }

  return didChange;
}

export function rotateLocalVectorByEntityRotation(
  world: CoreWorld,
  eid: number,
  localVector: Vec3,
): Vec3 {
  const { Rotation } = world.components;
  scratchEuler.set(
    Rotation.pitch[eid],
    Rotation.yaw[eid],
    Rotation.roll[eid],
  );
  scratchVector.set(localVector.x, localVector.y, localVector.z);
  scratchVector.applyEuler(scratchEuler);

  return {
    x: scratchVector.x,
    y: scratchVector.y,
    z: scratchVector.z,
  };
}
