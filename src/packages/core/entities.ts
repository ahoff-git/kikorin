import { addComponent, addEntity, hasComponent, query } from "bitecs";
import type {
  CoreComponentName,
  CoreEntityBlueprint,
  CoreWorld,
  Position,
  Rotation,
  Velocity,
} from "./types";
import { configureCuboidCollider } from "./systems/collision";
import { destroyEntity } from "./systems/entityCleanup";
import { upsertObjectByEid, setObjectTransformByEid } from "./systems/render";
import {
  markFlaginatorComponentChanged,
  markFlaginatorMarkerChanged,
  resetFlaginatorEntity,
} from "./systems/flaginator";
import {
  setEntityPosition,
  setEntityRotation,
  setEntityVelocity,
} from "./systems/transforms";

const ZERO_POSITION: Position = { x: 0, y: 0, z: 0 };
const ZERO_ROTATION: Rotation = { pitch: 0, yaw: 0, roll: 0 };
const ZERO_VELOCITY: Velocity = { x: 0, y: 0, z: 0 };

function getComponent(world: CoreWorld, name: CoreComponentName) {
  return world.components[name] as never;
}

function ensureComponent(
  world: CoreWorld,
  eid: number,
  componentName: CoreComponentName,
) {
  const component = getComponent(world, componentName);
  if (!hasComponent(world, eid, component)) {
    addComponent(world, eid, component);
  }
}

function readEntityPosition(world: CoreWorld, eid: number): Position {
  const { Position } = world.components;
  return {
    x: Position.x[eid],
    y: Position.y[eid],
    z: Position.z[eid],
  };
}

function readEntityRotation(world: CoreWorld, eid: number): Rotation {
  const { Rotation } = world.components;
  return {
    pitch: Rotation.pitch[eid],
    yaw: Rotation.yaw[eid],
    roll: Rotation.roll[eid],
  };
}

function syncRenderMesh(world: CoreWorld, eid: number) {
  const position = readEntityPosition(world, eid);
  const rotation = readEntityRotation(world, eid);
  setObjectTransformByEid(
    eid,
    position.x,
    position.y,
    position.z,
    rotation.pitch,
    rotation.yaw,
    rotation.roll,
  );
}

export function hasEntityComponents(
  world: CoreWorld,
  eid: number,
  componentNames: readonly CoreComponentName[],
): boolean {
  for (let i = 0; i < componentNames.length; i += 1) {
    if (!hasComponent(world, eid, getComponent(world, componentNames[i]!))) {
      return false;
    }
  }

  return true;
}

export function queryEntities(
  world: CoreWorld,
  componentNames: readonly CoreComponentName[],
): number[] {
  if (componentNames.length === 0) return [];
  return Array.from(
    query(
      world,
      componentNames.map((componentName) => getComponent(world, componentName)),
    ),
  );
}

export function spawnEntity(
  world: CoreWorld,
  definition: CoreEntityBlueprint = {},
): number {
  const eid = addEntity(world);
  resetFlaginatorEntity(world, eid);

  const wantsRender = definition.render === true || definition.renderMesh !== undefined;
  const needsPosition =
    definition.position !== undefined ||
    definition.collider !== undefined ||
    definition.floor === true ||
    definition.gravity !== undefined ||
    wantsRender;
  const needsRotation =
    definition.rotation !== undefined ||
    definition.collider !== undefined ||
    definition.floor === true ||
    wantsRender;
  const needsVelocity =
    definition.velocity !== undefined || definition.gravity !== undefined;

  if (needsPosition) ensureComponent(world, eid, "Position");
  if (needsVelocity) ensureComponent(world, eid, "Velocity");
  if (needsRotation) ensureComponent(world, eid, "Rotation");
  if (definition.faceVelocity === true) ensureComponent(world, eid, "FaceVelocity");
  if (definition.collider !== undefined) ensureComponent(world, eid, "Collider");
  if (definition.gravity !== undefined) ensureComponent(world, eid, "Gravity");
  if (definition.floor === true) ensureComponent(world, eid, "Floor");
  if (definition.health !== undefined) ensureComponent(world, eid, "Health");
  if (definition.player !== undefined) ensureComponent(world, eid, "Player");
  if (wantsRender) ensureComponent(world, eid, "Render");

  if (wantsRender) {
    world.components.Render[eid] = 1;
  }

  if (needsPosition) {
    const position = definition.position ?? ZERO_POSITION;
    setEntityPosition(world, eid, {
      x: position.x ?? ZERO_POSITION.x,
      y: position.y ?? ZERO_POSITION.y,
      z: position.z ?? ZERO_POSITION.z,
    });
  }

  if (needsVelocity) {
    const velocity = definition.velocity ?? ZERO_VELOCITY;
    setEntityVelocity(world, eid, {
      x: velocity.x ?? ZERO_VELOCITY.x,
      y: velocity.y ?? ZERO_VELOCITY.y,
      z: velocity.z ?? ZERO_VELOCITY.z,
    });
  }

  if (needsRotation) {
    const rotation = definition.rotation ?? ZERO_ROTATION;
    setEntityRotation(world, eid, {
      pitch: rotation.pitch ?? ZERO_ROTATION.pitch,
      yaw: rotation.yaw ?? ZERO_ROTATION.yaw,
      roll: rotation.roll ?? ZERO_ROTATION.roll,
    });
  }

  if (definition.collider) {
    configureCuboidCollider(world, eid, definition.collider);
  }

  if (definition.gravity !== undefined) {
    const grounded =
      typeof definition.gravity === "object" && definition.gravity.grounded
        ? 1
        : 0;
    world.components.Gravity.Grounded[eid] = grounded;
    markFlaginatorComponentChanged(world, "Gravity", eid);
  }

  if (definition.floor === true) {
    world.components.Floor[eid] = 1;
    markFlaginatorComponentChanged(world, "Floor", eid);
  }

  if (definition.health !== undefined) {
    world.components.Health[eid] = definition.health;
    markFlaginatorComponentChanged(world, "Health", eid);
    markFlaginatorMarkerChanged(world, "HealthChanged", eid);
  }

  if (definition.player !== undefined) {
    world.components.Player[eid] = { ...definition.player };
    markFlaginatorComponentChanged(world, "Player", eid);
  }

  if (definition.faceVelocity === true) {
    world.components.FaceVelocity[eid] = 1;
  }

  if (definition.renderMesh !== undefined) {
    upsertObjectByEid(eid, definition.renderMesh);
    syncRenderMesh(world, eid);
  }

  return eid;
}

export {
  destroyEntity,
  setEntityPosition,
  setEntityRotation,
  setEntityVelocity,
};
