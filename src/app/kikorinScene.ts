import {
  getYawFromXZDirection,
  queryEntities,
  spawnEntity,
  type CoreWorld,
  type Player,
  type Position,
  type Rotation,
  type Velocity,
} from "@/packages/core/core";
import { findHighestFloorTopAtPosition } from "@/packages/core/systems/gravity";
import { rng } from "@/packages/util/random";
import {
  createFloorRenderMesh,
  createPersonRenderMesh,
  FLOOR_COLLIDER,
  FLOOR_TOP_Y,
  PERSON_COLLIDER,
} from "./kikorinSceneMeshes";

export { FLOOR_POSITION } from "./kikorinSceneMeshes";

const AMBIENT_PERSON_COUNT = 8000;

export type FloorEids = ArrayLike<number>;

export function queryFloorEids(world: CoreWorld): FloorEids {
  return queryEntities(world, ["Floor", "Position", "Rotation", "Collider"]);
}

export function clampSpawnPositionToFloor(
  world: CoreWorld,
  position: Position,
  halfHeight: number,
  floorEids: FloorEids = queryFloorEids(world),
) {
  const floorTop = findHighestFloorTopAtPosition(
    world,
    floorEids,
    position.x,
    position.z,
  );
  if (floorTop === null) {
    return position;
  }

  return {
    x: position.x,
    y: Math.max(position.y, floorTop + halfHeight),
    z: position.z,
  };
}

function createPerson(
  world: CoreWorld,
  position: Position,
  velocity: Velocity,
  rotation: Rotation,
  faceVelocity: boolean,
  health: number,
  player: Player,
  floorEids: FloorEids = queryFloorEids(world),
) {
  const spawnPosition = clampSpawnPositionToFloor(
    world,
    position,
    PERSON_COLLIDER.halfHeight,
    floorEids,
  );

  return spawnEntity(world, {
    position: spawnPosition,
    velocity,
    rotation,
    faceVelocity,
    gravity: true,
    health,
    player,
    collider: PERSON_COLLIDER,
    renderMesh: createPersonRenderMesh,
  });
}

export function createPrimePlayer(world: CoreWorld, floorEids: FloorEids) {
  return createPerson(
    world,
    { x: 0, y: 12, z: 0 },
    { x: 0, y: 0, z: 0 },
    { pitch: 0, yaw: 0, roll: 0 },
    false,
    100,
    { level: 0, experience: 0, name: "DoomPrime" },
    floorEids,
  );
}

function isAmbientPersonMoving() {
  return rng(0, 10) > 9;
}

function createAmbientPersonVelocity(moving: boolean): Velocity {
  return {
    x: moving ? rng(-10, 10, 2) : 0,
    y: 0,
    z: moving ? rng(-10, 10, 2) : 0,
  };
}

function createAmbientPersonPosition(
  spawnRangeX: number,
  spawnRangeZ: number,
): Position {
  return {
    x: rng(-spawnRangeX, spawnRangeX),
    y: rng(FLOOR_TOP_Y + 4, FLOOR_TOP_Y + 60),
    z: rng(-spawnRangeZ, spawnRangeZ),
  };
}

function createAmbientPersonRotation(
  velocity: Velocity,
  moving: boolean,
): Rotation {
  return {
    pitch: 0,
    yaw: moving
      ? getYawFromXZDirection(velocity.x, velocity.z)
      : rng(0, Math.PI * 2, 3),
    roll: 0,
  };
}

function createAmbientPersonPlayer(index: number): Player {
  return {
    level: 0,
    experience: 0,
    name: `Doom${index}`,
  };
}

function spawnAmbientPerson(
  world: CoreWorld,
  floorEids: FloorEids,
  index: number,
  spawnRangeX: number,
  spawnRangeZ: number,
) {
  const moving = isAmbientPersonMoving();
  const velocity = createAmbientPersonVelocity(moving);

  createPerson(
    world,
    createAmbientPersonPosition(spawnRangeX, spawnRangeZ),
    velocity,
    createAmbientPersonRotation(velocity, moving),
    moving,
    100,
    createAmbientPersonPlayer(index),
    floorEids,
  );
}

export function spawnAmbientPeople(
  world: CoreWorld,
  floorEids: FloorEids,
  count = AMBIENT_PERSON_COUNT,
) {
  const spawnRangeX = FLOOR_COLLIDER.halfWidth - 4;
  const spawnRangeZ = FLOOR_COLLIDER.halfDepth - 4;

  for (let i = 0; i < count; i += 1) {
    spawnAmbientPerson(world, floorEids, i, spawnRangeX, spawnRangeZ);
  }
}

export function createFloor(world: CoreWorld, position: Position) {
  return spawnEntity(world, {
    position,
    floor: true,
    collider: FLOOR_COLLIDER,
    renderMesh: createFloorRenderMesh,
  });
}
