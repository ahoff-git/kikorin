import { addComponent, addEntity, query } from "bitecs";
import {
  configureCuboidCollider,
  ControlSources,
  KeyboardControls,
  rotateLocalVectorByEntityRotation,
  setEntityRotation,
  setupCoreWorld,
  type CoreWorld,
  type CoreWorldBox,
  type Player,
  type Position,
  type Rotation,
  type Velocity,
} from "@/packages/core/core";
import { findHighestFloorTopAtPosition } from "@/packages/core/systems/gravity";
import {
  setObjectTransformByEid,
  upsertObjectByEid,
} from "@/packages/core/systems/render";
import { clamp, rng } from "@/packages/util/random";
import type { Object3D } from "three";
import {
  BoxGeometry,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
} from "three";
import { PlayerReactControls } from "./kikorinControls";

const PERSON_COLLIDER = {
  halfWidth: 0.5,
  halfHeight: 0.5,
  halfDepth: 0.5,
};
const PERSON_GEOMETRY = new BoxGeometry(
  PERSON_COLLIDER.halfWidth * 2,
  PERSON_COLLIDER.halfHeight * 2,
  PERSON_COLLIDER.halfDepth * 2,
);
const PERSON_EDGE_GEOMETRY = new EdgesGeometry(PERSON_GEOMETRY);
const PERSON_BODY_COLOR = 0x66ccff;
const PERSON_FRONT_COLOR = 0xffe082;
const PERSON_TOUCH_COLOR = 0xff6b3d;
const PERSON_TOUCH_FRONT_COLOR = 0xffc46b;
const PERSON_EDGE_MATERIAL = new LineBasicMaterial({ color: 0x16324f });
const FLOOR_COLLIDER = {
  halfWidth: 240,
  halfHeight: 1,
  halfDepth: 240,
};
const FLOOR_TOP_Y = 0;
const FLOOR_GEOMETRY = new BoxGeometry(
  FLOOR_COLLIDER.halfWidth * 2,
  FLOOR_COLLIDER.halfHeight * 2,
  FLOOR_COLLIDER.halfDepth * 2,
);
const FLOOR_EDGE_GEOMETRY = new EdgesGeometry(FLOOR_GEOMETRY);
const FLOOR_BASE_MATERIAL = new MeshBasicMaterial({ color: 0x445342 });
const FLOOR_EDGE_MATERIAL = new LineBasicMaterial({ color: 0x243022 });
const FLOOR_POSITION = {
  x: 0,
  y: FLOOR_TOP_Y - FLOOR_COLLIDER.halfHeight,
  z: 0,
};
const PLAYER_ACCELERATION = 30;
const PLAYER_MAX_SPEED = 18;
const PLAYER_DRAG_PER_SECOND = 4;
const PLAYER_JUMP_SPEED = 8;
const PLAYER_FORWARD_BOOST = 10;
const PLAYER_FORWARD_KEYS = [
  KeyboardControls.KeyW,
  KeyboardControls.ArrowUp,
];
const PLAYER_BACKWARD_KEYS = [
  KeyboardControls.KeyS,
  KeyboardControls.ArrowDown,
];
const PLAYER_STRAFE_LEFT_KEYS = [KeyboardControls.KeyQ];
const PLAYER_STRAFE_RIGHT_KEYS = [KeyboardControls.KeyE];
const PLAYER_LOOK_LEFT_KEYS = [
  KeyboardControls.KeyA,
  KeyboardControls.ArrowLeft,
];
const PLAYER_LOOK_RIGHT_KEYS = [
  KeyboardControls.KeyD,
  KeyboardControls.ArrowRight,
];
const PLAYER_PITCH_UP_KEYS = [KeyboardControls.KeyI];
const PLAYER_PITCH_DOWN_KEYS = [KeyboardControls.KeyK];
const PLAYER_PITCH_SPEED = 1.5;
const PLAYER_YAW_SPEED = 1.5;
const PLAYER_MAX_PITCH = Math.PI * 0.45;
const AMBIENT_PERSON_COUNT = 8000;
const ZERO_ROTATION: Rotation = { pitch: 0, yaw: 0, roll: 0 };

function createPersonFaceMaterials(bodyColor: number, frontColor: number) {
  return [
    ...Array.from({ length: 5 }, () => {
      return new MeshBasicMaterial({ color: bodyColor });
    }),
    // BoxGeometry groups are +X, -X, +Y, -Y, +Z, -Z. This project treats -Z as forward.
    new MeshBasicMaterial({ color: frontColor }),
  ];
}

const PERSON_BASE_MATERIALS = createPersonFaceMaterials(
  PERSON_BODY_COLOR,
  PERSON_FRONT_COLOR,
);
const PERSON_TOUCH_MATERIALS = createPersonFaceMaterials(
  PERSON_TOUCH_COLOR,
  PERSON_TOUCH_FRONT_COLOR,
);

export type World = CoreWorld;
export type WorldBox = CoreWorldBox;

type EntityComponent = World["components"][keyof World["components"]];
type FloorEids = ArrayLike<number>;
type RenderableEntityOptions = {
  position: Position;
  rotation?: Rotation;
  collider: Parameters<typeof configureCuboidCollider>[2];
  createRenderMesh: () => Object3D;
};

function createPersonRenderMesh() {
  const mesh = new Mesh(PERSON_GEOMETRY, PERSON_BASE_MATERIALS);
  const outline = new LineSegments(PERSON_EDGE_GEOMETRY, PERSON_EDGE_MATERIAL);
  outline.renderOrder = 1;
  outline.scale.setScalar(1.001);
  mesh.userData.baseMaterial = PERSON_BASE_MATERIALS;
  mesh.userData.touchMaterial = PERSON_TOUCH_MATERIALS;
  mesh.add(outline);
  return mesh;
}

function createFloorRenderMesh() {
  const mesh = new Mesh(FLOOR_GEOMETRY, FLOOR_BASE_MATERIAL);
  const outline = new LineSegments(FLOOR_EDGE_GEOMETRY, FLOOR_EDGE_MATERIAL);
  outline.renderOrder = 1;
  outline.scale.setScalar(1.0005);
  mesh.add(outline);
  return mesh;
}

function setupWorld(canvas: HTMLCanvasElement | null) {
  const worldBox: WorldBox = setupCoreWorld(canvas);
  createFloor(worldBox.world, FLOOR_POSITION);

  const floorEids = queryFloorEids(worldBox.world);
  const prime = createPrimePlayer(worldBox.world, floorEids);
  registerPrimeControls(worldBox.world, prime);
  worldBox.setCameraFollowTarget(prime);
  spawnAmbientPeople(worldBox.world, floorEids);

  return worldBox;
}

function queryFloorEids(world: World): FloorEids {
  return query(world, [
    world.components.Floor,
    world.components.Position,
    world.components.Rotation,
    world.components.Collider,
  ]);
}

function createPrimePlayer(world: CoreWorld, floorEids: FloorEids) {
  return createPerson(
    world,
    { x: 0, y: 12, z: 0 },
    { x: 0, y: 0, z: 0 },
    100,
    { level: 0, experience: 0, name: "DoomPrime" },
    floorEids,
  );
}

function spawnAmbientPeople(
  world: CoreWorld,
  floorEids: FloorEids,
  count = AMBIENT_PERSON_COUNT,
) {
  const spawnRangeX = FLOOR_COLLIDER.halfWidth - 4;
  const spawnRangeZ = FLOOR_COLLIDER.halfDepth - 4;

  for (let i = 0; i < count; i += 1) {
    const moving = rng(0, 10) > 9; // 10% chance to be moving
    const velocity = {
      x: moving ? rng(-10, 10, 2) : 0,
      y: 0,
      z: moving ? rng(-10, 10, 2) : 0,
    };
    const position = {
      x: rng(-spawnRangeX, spawnRangeX),
      y: rng(FLOOR_TOP_Y + 4, FLOOR_TOP_Y + 60),
      z: rng(-spawnRangeZ, spawnRangeZ),
    };

    createPerson(
      world,
      position,
      velocity,
      100,
      {
        level: 0,
        experience: 0,
        name: `Doom${i}`,
      },
      floorEids,
    );
  }
}

function registerPrimeControls(world: CoreWorld, eid: number) {
  const jump = (activeWorld: CoreWorld) => {
    const { Gravity, Velocity } = activeWorld.components;
    if (Gravity.Grounded[eid] === 0) return;

    Velocity.y[eid] = clamp(
      PLAYER_JUMP_SPEED,
      -PLAYER_MAX_SPEED,
      PLAYER_MAX_SPEED,
    );
    Gravity.Grounded[eid] = 0;
  };

  world.controls.onTick((activeWorld, tick, controls) => {
    const dt = tick.deltaSeconds;
    if (dt === 0) return;

    const drag = Math.max(0, 1 - PLAYER_DRAG_PER_SECOND * dt);
    const { Velocity, Rotation } = activeWorld.components;
    Velocity.x[eid] *= drag;
    Velocity.z[eid] *= drag;

    const localAcceleration = {
      x:
        controls.getAxis(
          PLAYER_STRAFE_LEFT_KEYS,
          PLAYER_STRAFE_RIGHT_KEYS,
          ControlSources.Keyboard,
        ) * PLAYER_ACCELERATION,
      y: 0,
      z:
        controls.getAxis(
          PLAYER_FORWARD_KEYS,
          PLAYER_BACKWARD_KEYS,
          ControlSources.Keyboard,
        ) * PLAYER_ACCELERATION,
    };
    const pitchAxis = controls.getAxis(
      PLAYER_PITCH_DOWN_KEYS,
      PLAYER_PITCH_UP_KEYS,
      ControlSources.Keyboard,
    );
    const yawAxis = controls.getAxis(
      PLAYER_LOOK_RIGHT_KEYS,
      PLAYER_LOOK_LEFT_KEYS,
      ControlSources.Keyboard,
    );
    const worldAcceleration = rotateLocalVectorByEntityRotation(
      activeWorld,
      eid,
      localAcceleration,
    );

    Velocity.x[eid] = clamp(
      Velocity.x[eid] + worldAcceleration.x * dt,
      -PLAYER_MAX_SPEED,
      PLAYER_MAX_SPEED,
    );
    Velocity.y[eid] = clamp(
      Velocity.y[eid] + worldAcceleration.y * dt,
      -PLAYER_MAX_SPEED,
      PLAYER_MAX_SPEED,
    );
    Velocity.z[eid] = clamp(
      Velocity.z[eid] + worldAcceleration.z * dt,
      -PLAYER_MAX_SPEED,
      PLAYER_MAX_SPEED,
    );

    if (pitchAxis === 0 && yawAxis === 0) return;

    const nextRotation: Partial<Rotation> = {};
    if (pitchAxis !== 0) {
      nextRotation.pitch = clamp(
        Rotation.pitch[eid] + pitchAxis * PLAYER_PITCH_SPEED * dt,
        -PLAYER_MAX_PITCH,
        PLAYER_MAX_PITCH,
      );
    }
    if (yawAxis !== 0) {
      nextRotation.yaw = Rotation.yaw[eid] + yawAxis * PLAYER_YAW_SPEED * dt;
    }
    setEntityRotation(activeWorld, eid, nextRotation);
  });

  world.controls.on(
    {
      source: ControlSources.Keyboard,
      controlId: KeyboardControls.Space,
      phase: "start",
    },
    (activeWorld) => {
      jump(activeWorld);
    },
  );

  world.controls.on(
    {
      source: ControlSources.React,
      controlId: PlayerReactControls.BoostForward,
      phase: "trigger",
    },
    (activeWorld) => {
      const { Velocity } = activeWorld.components;
      Velocity.z[eid] = clamp(
        Velocity.z[eid] - PLAYER_FORWARD_BOOST,
        -PLAYER_MAX_SPEED,
        PLAYER_MAX_SPEED,
      );
    },
  );
}

function createEntityWithComponents(
  world: World,
  components: readonly EntityComponent[],
) {
  const eid = addEntity(world);
  for (const component of components) {
    addComponent(world, eid, component as never);
  }
  return eid;
}

function assignPosition(
  positions: World["components"]["Position"],
  eid: number,
  position: Position,
) {
  positions.x[eid] = position.x;
  positions.y[eid] = position.y;
  positions.z[eid] = position.z;
}

function assignVelocity(
  velocities: World["components"]["Velocity"],
  eid: number,
  velocity: Velocity,
) {
  velocities.x[eid] = velocity.x;
  velocities.y[eid] = velocity.y;
  velocities.z[eid] = velocity.z;
}

function assignRotation(
  rotations: World["components"]["Rotation"],
  eid: number,
  rotation: Rotation = ZERO_ROTATION,
) {
  rotations.pitch[eid] = rotation.pitch;
  rotations.yaw[eid] = rotation.yaw;
  rotations.roll[eid] = rotation.roll;
}

function syncRenderMesh(
  eid: number,
  position: Position,
  rotation: Rotation,
  createRenderMesh: () => Object3D,
) {
  upsertObjectByEid(eid, createRenderMesh);
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

function initializeRenderableEntity(
  world: World,
  eid: number,
  {
    position,
    rotation = ZERO_ROTATION,
    collider,
    createRenderMesh,
  }: RenderableEntityOptions,
) {
  assignPosition(world.components.Position, eid, position);
  assignRotation(world.components.Rotation, eid, rotation);
  world.components.Render[eid] = 1;
  configureCuboidCollider(world, eid, collider);
  syncRenderMesh(eid, position, rotation, createRenderMesh);
}

function clampPersonSpawnPositionToFloor(
  world: World,
  position: Position,
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
    y: Math.max(position.y, floorTop + PERSON_COLLIDER.halfHeight),
    z: position.z,
  };
}

function createPerson(
  world: World,
  position: Position,
  velocity: Velocity,
  health: number,
  player: Player,
  floorEids: FloorEids = queryFloorEids(world),
) {
  const {
    Position,
    Velocity,
    Rotation,
    Player,
    Health,
    Render,
    Collider,
    Gravity,
  } = world.components;
  const spawnPosition = clampPersonSpawnPositionToFloor(
    world,
    position,
    floorEids,
  );
  const eid = createEntityWithComponents(world, [
    Position,
    Velocity,
    Rotation,
    Collider,
    Gravity,
    Player,
    Health,
    Render,
  ]);

  assignVelocity(Velocity, eid, velocity);
  Gravity.Grounded[eid] = 0;
  Health[eid] = health;
  Player[eid] = player;

  initializeRenderableEntity(world, eid, {
    position: spawnPosition,
    collider: PERSON_COLLIDER,
    createRenderMesh: createPersonRenderMesh,
  });

  return eid;
}

function createFloor(world: World, position: Position) {
  const { Position, Rotation, Render, Collider, Floor } = world.components;
  const eid = createEntityWithComponents(world, [
    Position,
    Rotation,
    Collider,
    Render,
    Floor,
  ]);

  Floor[eid] = 1;
  initializeRenderableEntity(world, eid, {
    position,
    collider: FLOOR_COLLIDER,
    createRenderMesh: createFloorRenderMesh,
  });

  return eid;
}

export { setupWorld };
