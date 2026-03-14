import { Euler, Vector3 } from "three";
import type { CoreWorld, Position, Rotation, Vec3, Velocity } from "../types";
import {
  markFlaginatorComponentChanged,
  markFlaginatorMarkerChanged,
} from "./flaginator";
import { markCollisionTransformDirty } from "./collision";

const scratchEuler = new Euler();
const scratchVector = new Vector3();

export function markTransformDirty(world: CoreWorld, eid: number) {
  const { RenderDirtyFlags, Render, Collider } = world.components;
  markFlaginatorMarkerChanged(world, "Moved", eid);

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

export function setEntityPosition(
  world: CoreWorld,
  eid: number,
  position: Partial<Position>,
): boolean {
  const { Position } = world.components;
  let didChange = false;

  if (position.x !== undefined && Position.x[eid] !== position.x) {
    Position.x[eid] = position.x;
    didChange = true;
  }

  if (position.y !== undefined && Position.y[eid] !== position.y) {
    Position.y[eid] = position.y;
    didChange = true;
  }

  if (position.z !== undefined && Position.z[eid] !== position.z) {
    Position.z[eid] = position.z;
    didChange = true;
  }

  if (didChange) {
    markFlaginatorComponentChanged(world, "Position", eid);
    markTransformDirty(world, eid);
  }

  return didChange;
}

export function setEntityVelocity(
  world: CoreWorld,
  eid: number,
  velocity: Partial<Velocity>,
): boolean {
  const { Velocity } = world.components;
  let didChange = false;

  if (velocity.x !== undefined && Velocity.x[eid] !== velocity.x) {
    Velocity.x[eid] = velocity.x;
    didChange = true;
  }

  if (velocity.y !== undefined && Velocity.y[eid] !== velocity.y) {
    Velocity.y[eid] = velocity.y;
    didChange = true;
  }

  if (velocity.z !== undefined && Velocity.z[eid] !== velocity.z) {
    Velocity.z[eid] = velocity.z;
    didChange = true;
  }

  if (didChange) {
    markFlaginatorComponentChanged(world, "Velocity", eid);
  }

  return didChange;
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
    markFlaginatorComponentChanged(world, "Rotation", eid);
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
